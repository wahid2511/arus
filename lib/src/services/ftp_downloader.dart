import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import '../core/path_utils.dart';
import '../models/download_models.dart';
import 'download_worker.dart';
import 'rate_limiter.dart';
import 'segmented_downloader.dart';

/// Error returned by the small, plain-FTP client used by Arus.
class FtpException implements Exception {
  const FtpException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() =>
      statusCode == null ? message : 'FTP $statusCode: $message';
}

/// Basic passive-mode FTP downloader with resume support.
///
/// FTP is deliberately kept separate from the HTTP engine: servers vary in
/// their support for SIZE/REST, so a failed REST negotiation safely falls
/// back to a fresh transfer instead of appending bytes at the wrong offset.
class FtpDownloader implements DownloadWorker {
  FtpDownloader({
    required this.id,
    required this.url,
    required this.filePath,
    required this.tempPath,
    required this.metaPath,
    required this.maxRetries,
    required this.onProgress,
    this.rateLimiter,
  });

  final String id;
  final String url;
  final String filePath;
  final String tempPath;
  final String metaPath;
  final int maxRetries;
  final DownloadProgressCallback onProgress;
  final DownloadRateLimiter? rateLimiter;

  Socket? _controlSocket;
  Socket? _dataSocket;
  _FtpControlChannel? _control;
  String? _abortReason;
  int _downloadedBytes = 0;
  int? _totalBytes;
  DateTime _startedAt = DateTime.now();
  DateTime _lastProgressAt = DateTime.now();
  int _lastProgressBytes = 0;
  int _lastSpeedBytesPerSecond = 0;

  @override
  Future<void> start() async {
    _abortReason = null;
    _startedAt = DateTime.now();
    _lastProgressAt = _startedAt;
    _lastProgressBytes = 0;
    _lastSpeedBytesPerSecond = 0;
    await Directory(parentPath(filePath)).create(recursive: true);

    var attempt = 0;
    while (true) {
      _throwIfAborted();
      try {
        await _downloadOnce();
        return;
      } catch (error) {
        await _disconnect();
        if (_abortReason != null ||
            attempt >= maxRetries ||
            !_isRetryable(error)) {
          rethrow;
        }
        attempt += 1;
        await Future<void>.delayed(_retryDelay(attempt));
      }
    }
  }

  @override
  void pause() {
    _abortReason = 'paused';
    _dataSocket?.destroy();
    _controlSocket?.destroy();
  }

  @override
  void cancel() {
    _abortReason = 'cancelled';
    _dataSocket?.destroy();
    _controlSocket?.destroy();
  }

  Future<void> _downloadOnce() async {
    final uri = Uri.parse(url);
    final user = uri.userInfo.isEmpty
        ? 'anonymous'
        : Uri.decodeComponent(uri.userInfo.split(':').first);
    final password = uri.userInfo.contains(':')
        ? Uri.decodeComponent(
            uri.userInfo.substring(uri.userInfo.indexOf(':') + 1),
          )
        : 'arus@localhost';
    final path = uri.path.isEmpty ? '/' : Uri.decodeComponent(uri.path);

    _controlSocket = await Socket.connect(
      uri.host,
      uri.hasPort ? uri.port : 21,
      timeout: const Duration(seconds: 30),
    );
    _control = _FtpControlChannel(_controlSocket!);

    var reply = await _control!.readReply();
    _checkReply(reply, const <int>{220, 230});
    if (reply.code != 230) {
      reply = await _control!.command('USER $user');
      if (reply.code == 331) {
        reply = await _control!.command('PASS $password');
      }
      _checkReply(reply, const <int>{230});
    }

    reply = await _control!.command('TYPE I');
    _checkReply(reply, const <int>{200});

    reply = await _control!.command('SIZE $path');
    if (reply.code == 213) {
      _totalBytes = int.tryParse(
        reply.message.trim().split(RegExp(r'\s+')).last,
      );
    } else {
      _totalBytes = null;
    }

    var existing = await _existingLength();
    if (_totalBytes != null && existing > _totalBytes!) {
      await _deletePartFiles();
      existing = 0;
    }

    if (existing > 0) {
      reply = await _control!.command('REST $existing');
      if (reply.code != 350) {
        // REST is optional in FTP. Restart cleanly if the server cannot
        // resume, rather than producing a file with duplicated bytes.
        await _deletePartFiles();
        existing = 0;
      }
    }

    _downloadedBytes = existing;
    _emitProgress();
    _dataSocket = await _openPassiveSocket(uri);
    reply = await _control!.command('RETR $path');
    _checkReply(reply, const <int>{125, 150});

    final handle = await File(
      tempPath,
    ).open(mode: existing > 0 ? FileMode.writeOnly : FileMode.write);
    var position = existing;
    try {
      await for (final chunk in _dataSocket!) {
        _throwIfAborted();
        var offset = 0;
        while (offset < chunk.length) {
          final sliceLength = math.min(
            chunk.length - offset,
            rateLimiter?.suggestedChunkBytes ??
                DownloadRateLimiter.maxChunkBytes,
          );
          final slice = chunk.sublist(offset, offset + sliceLength);
          await rateLimiter?.throttle(
            slice.length,
            isCancelled: () => _abortReason != null,
          );
          _throwIfAborted();
          await handle.setPosition(position);
          await handle.writeFrom(slice);
          position += slice.length;
          offset += slice.length;
          _downloadedBytes += slice.length;
          _emitProgress();
        }
      }
    } finally {
      await handle.close();
      _dataSocket?.destroy();
      _dataSocket = null;
    }

    reply = await _control!.readReply();
    _checkReply(reply, const <int>{226, 250});
    if (_totalBytes != null && _downloadedBytes != _totalBytes) {
      throw StateError(
        'FTP file size mismatch: expected $_totalBytes bytes, got $_downloadedBytes',
      );
    }

    await _disconnect();
    final target = File(filePath);
    if (await target.exists()) {
      throw StateError('Destination file already exists: $filePath');
    }
    await File(tempPath).rename(filePath);
    await _deletePartFiles(includePart: false);
    _emitProgress();
  }

  Future<Socket> _openPassiveSocket(Uri uri) async {
    var reply = await _control!.command('EPSV');
    int? port;
    if (reply.code == 229) {
      port = int.tryParse(
        RegExp(r'\(\|\|\|(\d+)\|\)').firstMatch(reply.message)?.group(1) ?? '',
      );
    }

    InternetAddress address;
    if (port == null) {
      reply = await _control!.command('PASV');
      _checkReply(reply, const <int>{227});
      final match = RegExp(
        r'\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)',
      ).firstMatch(reply.message);
      if (match == null) {
        throw const FtpException(
          'FTP server returned an invalid PASV response',
        );
      }
      address = InternetAddress(
        '${match.group(1)}.${match.group(2)}.${match.group(3)}.${match.group(4)}',
      );
      port = int.parse(match.group(5)!) * 256 + int.parse(match.group(6)!);
    } else {
      address = _controlSocket!.remoteAddress;
    }
    return Socket.connect(address, port, timeout: const Duration(seconds: 30));
  }

  Future<int> _existingLength() async {
    try {
      return await File(tempPath).length();
    } catch (_) {
      return 0;
    }
  }

  Future<void> _deletePartFiles({bool includePart = true}) async {
    for (final path in <String>[
      if (includePart) tempPath,
      metaPath,
      '$metaPath.tmp',
    ]) {
      try {
        final file = File(path);
        if (await file.exists()) {
          await file.delete();
        }
      } catch (_) {
        // The manager retries cleanup after cancellation on Windows.
      }
    }
  }

  Future<void> _disconnect() async {
    _dataSocket?.destroy();
    _controlSocket?.destroy();
    _dataSocket = null;
    _controlSocket = null;
    _control = null;
  }

  void _emitProgress() {
    final now = DateTime.now();
    final elapsed = now.difference(_lastProgressAt).inMilliseconds;
    var speed = _lastSpeedBytesPerSecond;
    if (_downloadedBytes == 0) {
      speed = 0;
    } else if (elapsed >= 200) {
      speed = math.max(
        0,
        ((_downloadedBytes - _lastProgressBytes) * 1000 / elapsed).round(),
      );
      _lastSpeedBytesPerSecond = speed;
      _lastProgressAt = now;
      _lastProgressBytes = _downloadedBytes;
    }
    onProgress(
      DownloadProgress(
        id: id,
        downloadedBytes: _downloadedBytes,
        totalBytes: _totalBytes,
        speedBytesPerSecond: speed,
        percent: _totalBytes == null || _totalBytes == 0
            ? 0
            : (_downloadedBytes / _totalBytes! * 100).clamp(0, 100).toDouble(),
      ),
    );
  }

  void _checkReply(_FtpReply reply, Set<int> expected) {
    if (!expected.contains(reply.code)) {
      throw FtpException(reply.message, statusCode: reply.code);
    }
  }

  void _throwIfAborted() {
    final reason = _abortReason;
    if (reason != null) {
      throw DownloadAbortException(reason);
    }
  }
}

class _FtpControlChannel {
  _FtpControlChannel(Socket socket)
    : _socket = socket,
      _lines = StreamIterator<String>(
        socket
            .cast<List<int>>()
            .transform(utf8.decoder)
            .transform(const LineSplitter()),
      );

  final Socket _socket;
  final StreamIterator<String> _lines;

  Future<_FtpReply> command(String command) async {
    _socket.write('$command\r\n');
    await _socket.flush();
    return readReply();
  }

  Future<_FtpReply> readReply() async {
    final first = await _nextLine();
    final match = RegExp(r'^(\d{3})([ -])(.*)$').firstMatch(first);
    if (match == null) {
      throw FtpException('Invalid FTP response: $first');
    }
    final code = int.parse(match.group(1)!);
    final multiline = match.group(2) == '-';
    final messages = <String>[match.group(3)!];
    if (multiline) {
      while (true) {
        final line = await _nextLine();
        if (line.startsWith('$code ')) {
          messages.add(line.substring(4));
          break;
        }
        messages.add(line);
      }
    }
    return _FtpReply(code, messages.join('\n'));
  }

  Future<String> _nextLine() async {
    if (!await _lines.moveNext()) {
      throw const SocketException('FTP control connection closed');
    }
    return _lines.current.trimRight();
  }
}

class _FtpReply {
  const _FtpReply(this.code, this.message);

  final int code;
  final String message;
}

bool _isRetryable(Object error) {
  if (error is SocketException || error is HttpException) {
    return true;
  }
  if (error is FtpException) {
    return error.statusCode == 421 ||
        error.statusCode == 425 ||
        error.statusCode == 426 ||
        error.statusCode == 450 ||
        error.statusCode == 451 ||
        error.statusCode == 452 ||
        (error.statusCode ?? 0) >= 500;
  }
  final message = error.toString().toLowerCase();
  return message.contains('timed out') || message.contains('connection closed');
}

Duration _retryDelay(int attempt) => Duration(
  milliseconds: math.min(8000, 300 * math.pow(2, attempt - 1).toInt()),
);
