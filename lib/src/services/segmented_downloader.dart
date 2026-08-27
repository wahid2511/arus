import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import '../core/path_utils.dart';
import '../models/download_models.dart';

class DownloadAbortException implements Exception {
  const DownloadAbortException(this.reason);

  final String reason;

  @override
  String toString() => reason == 'paused' ? 'Download paused' : 'Download cancelled';
}

class RangeSupportLostException implements Exception {
  const RangeSupportLostException([this.message = 'Server no longer supports byte ranges']);

  final String message;

  @override
  String toString() => message;
}

class DownloadHttpException implements Exception {
  const DownloadHttpException(this.statusCode);

  final int statusCode;

  @override
  String toString() => 'Server returned HTTP $statusCode';
}

class SegmentedDownloader {
  SegmentedDownloader({
    required this.id,
    required this.url,
    required this.filePath,
    required this.tempPath,
    required this.metaPath,
    required this.connections,
    required this.minSegmentSizeBytes,
    required this.maxRetries,
    required this.onProgress,
    this.requestHeaders,
  });

  final String id;
  final String url;
  final String filePath;
  final String tempPath;
  final String metaPath;
  final int connections;
  final int minSegmentSizeBytes;
  final int maxRetries;
  final Map<String, String>? requestHeaders;
  final void Function(DownloadProgress progress) onProgress;

  HttpClient? _client;
  Future<void> _metaChain = Future<void>.value();
  String _resolvedUrl = '';
  String? _etag;
  String? _lastModified;
  int _downloadedBytes = 0;
  int? _totalBytes;
  List<DownloadSegment> _segments = <DownloadSegment>[];
  DateTime _startedAt = DateTime.now();
  DateTime _lastProgressAt = DateTime.now();
  int _lastProgressBytes = 0;
  String? _abortReason;
  bool _finalized = false;

  Future<void> start() async {
    _client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 30)
      ..idleTimeout = const Duration(seconds: 30)
      ..maxConnectionsPerHost = math.max(8, connections);
    _resolvedUrl = url;
    _startedAt = DateTime.now();
    _lastProgressAt = _startedAt;
    _lastProgressBytes = 0;
    _abortReason = null;
    _finalized = false;

    try {
      await _ensureParentDirectories();
      final probe = await _probe(Uri.parse(_resolvedUrl));
      _resolvedUrl = probe.url.toString();
      _totalBytes = probe.totalBytes;
      _etag = probe.etag;
      _lastModified = probe.lastModified;

      if (probe.supportsRanges && probe.totalBytes != null && probe.totalBytes! > 0) {
        try {
          await _downloadSegmented(probe.totalBytes!);
        } on RangeSupportLostException {
          await _resetPartFiles();
          await _downloadSingleWithRetry(probe.totalBytes);
        }
      } else {
        await _downloadSingleWithRetry(probe.totalBytes);
      }

      _throwIfAborted();
      await _closeFile();
      await _validateCompletedFile();
      await _finalizeCompletedDownload();
      _emitProgress();
    } catch (error) {
      await _closeFile();
      if (_abortReason == 'paused' && !_finalized && _segments.isNotEmpty) {
        await _persistMeta(force: true).catchError((_) {});
      }
      rethrow;
    } finally {
      _client?.close(force: true);
      _client = null;
    }
  }

  void pause() {
    _abortReason = 'paused';
    _client?.close(force: true);
  }

  void cancel() {
    _abortReason = 'cancelled';
    _client?.close(force: true);
  }

  Future<void> _downloadSegmented(int totalBytes) async {
    _totalBytes = totalBytes;
    final resumed = await _loadMeta(totalBytes);
    if (!resumed) {
      _segments = _createSegments(totalBytes);
      _downloadedBytes = 0;
      await _preallocate(totalBytes);
      await _persistMeta(force: true);
    } else {
      _downloadedBytes = _segments.fold<int>(0, (sum, segment) => sum + segment.downloaded);
    }

    _emitProgress();
    final workers = _segments
        .where((segment) => segment.downloaded < segment.length)
        .map(_runSegmentWithRetry)
        .toList();
    await Future.wait(workers);
    _throwIfAborted();

    if (_segments.any((segment) => segment.downloaded < segment.length)) {
      throw StateError('Download incomplete');
    }
  }

  Future<void> _runSegmentWithRetry(DownloadSegment segment) async {
    segment.active = true;
    var attempt = 0;
    try {
      while (true) {
        _throwIfAborted();
        try {
          await _downloadSegment(segment);
          return;
        } catch (error) {
          if (_abortReason != null || error is RangeSupportLostException) {
            rethrow;
          }
          if (attempt >= maxRetries || !_isRetryable(error)) {
            rethrow;
          }
          attempt += 1;
          await _closeFile();
          await _ensureParentDirectories();
          await Future<void>.delayed(_retryDelay(attempt));
        }
      }
    } finally {
      segment.active = false;
    }
  }

  Future<void> _downloadSegment(DownloadSegment segment) async {
    final start = segment.start + segment.downloaded;
    if (start > segment.end) {
      return;
    }

    final response = await _request(
      'GET',
      Uri.parse(_resolvedUrl),
      <String, String>{
        'Range': 'bytes=$start-${segment.end}',
        ..._validatorHeaders(),
      },
    );

    if (response.statusCode == 200 || response.statusCode == 401 || response.statusCode == 403) {
      await response.drain<void>();
      if (response.statusCode == 200) {
        throw const RangeSupportLostException();
      }
      throw RangeSupportLostException(
        'Server rejected ranged request (HTTP ${response.statusCode})',
      );
    }
    if (response.statusCode != 206) {
      await response.drain<void>();
      throw DownloadHttpException(response.statusCode);
    }

    var position = start;
    final handle = await File(tempPath).open(mode: FileMode.append);
    try {
      await for (final chunk in response) {
        _throwIfAborted();
        if (chunk.isEmpty) {
          continue;
        }
        final capacity = segment.end - position + 1;
        if (capacity <= 0) {
          break;
        }
        final usable = chunk.length > capacity ? chunk.sublist(0, capacity) : chunk;
        await handle.setPosition(position);
        await handle.writeFrom(usable);
        position += usable.length;
        segment.downloaded = math.min(segment.length, segment.downloaded + usable.length);
        _downloadedBytes += usable.length;
        _emitProgress();
        if (usable.length < chunk.length || segment.downloaded >= segment.length) {
          break;
        }
      }
    } finally {
      await handle.close();
    }

    if (segment.downloaded < segment.length) {
      throw StateError('Connection closed before segment ${segment.index + 1} completed');
    }
    await _persistMeta(force: true);
  }

  Future<void> _downloadSingleWithRetry(int? knownTotal) async {
    var attempt = 0;
    while (true) {
      _throwIfAborted();
      try {
        await _closeFile();
        await _downloadSingle(knownTotal);
        return;
      } catch (error) {
        await _closeFile();
        if (_abortReason != null || attempt >= maxRetries || !_isRetryable(error)) {
          rethrow;
        }
        attempt += 1;
        await _ensureParentDirectories();
        await Future<void>.delayed(_retryDelay(attempt));
      }
    }
  }

  Future<void> _downloadSingle(int? knownTotal) async {
    _totalBytes = knownTotal;
    _segments = <DownloadSegment>[];
    var existing = await _existingLength();

    // A full-size .part can be a zero-filled preallocated file. It is not
    // safe to treat its length as proof that the download completed.
    if (_totalBytes != null && existing >= _totalBytes!) {
      await _resetPartFiles();
      existing = 0;
    }
    _downloadedBytes = existing;
    _emitProgress();

    final headers = <String, String>{};
    if (existing > 0) {
      headers['Range'] = 'bytes=$existing-';
      headers.addAll(_validatorHeaders());
    }

    final response = await _request('GET', Uri.parse(_resolvedUrl), headers);
    if (response.statusCode != 200 && response.statusCode != 206) {
      await response.drain<void>();
      throw DownloadHttpException(response.statusCode);
    }

    final resumed = response.statusCode == 206 && existing > 0;
    if (existing > 0 && !resumed) {
      await _resetPartFiles();
      existing = 0;
      _downloadedBytes = 0;
    }

    final responseTotal = _totalFromResponse(response, resumed ? existing : 0);
    if (responseTotal != null) {
      _totalBytes = responseTotal;
    }

    final handle = await File(tempPath).open(mode: resumed ? FileMode.append : FileMode.write);
    var position = resumed ? existing : 0;
    try {
      await for (final chunk in response) {
        _throwIfAborted();
        if (chunk.isEmpty) {
          continue;
        }
        await handle.setPosition(position);
        await handle.writeFrom(chunk);
        position += chunk.length;
        _downloadedBytes += chunk.length;
        _emitProgress();
      }
    } finally {
      await handle.close();
    }

    if (_totalBytes != null && _downloadedBytes < _totalBytes!) {
      throw StateError('Connection closed before the download completed');
    }
  }

  Future<ProbeResult> _probe(Uri uri) async {
    var head = ProbeResult.empty();
    try {
      final response = await _request('HEAD', uri, const <String, String>{});
      head = ProbeResult.fromResponse(uri, response);
      await response.drain<void>();
    } catch (_) {
      // Some download hosts reject HEAD. The range probe below is enough to
      // discover the size and whether segmented mode is safe.
    }

    try {
      final response = await _request(
        'GET',
        uri,
        const <String, String>{'Range': 'bytes=0-0'},
      );
      final range = ProbeResult.fromResponse(uri, response, fallback: head);
      await response.drain<void>();
      if (response.statusCode == 206) {
        return range.copyWith(supportsRanges: true);
      }
      return range.copyWith(supportsRanges: false);
    } catch (_) {
      return head.copyWith(url: uri, supportsRanges: false);
    }
  }

  Future<HttpClientResponse> _request(
    String method,
    Uri uri,
    Map<String, String> headers,
  ) async {
    final client = _client;
    if (client == null) {
      throw StateError('Download client is not initialized');
    }
    final request = await client.openUrl(method, uri);
    request.followRedirects = true;
    request.maxRedirects = 5;
    request.headers.set(HttpHeaders.userAgentHeader, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
    request.headers.set(HttpHeaders.acceptHeader, '*/*');
    try {
      request.headers.set(HttpHeaders.refererHeader, '${uri.origin}/');
    } catch (_) {
      // Uri is already parsed, but keep the request resilient to unusual URLs.
    }
    for (final entry in requestHeaders?.entries ?? const <MapEntry<String, String>>[]) {
      request.headers.set(entry.key, entry.value);
    }
    for (final entry in headers.entries) {
      request.headers.set(entry.key, entry.value);
    }
    return request.close();
  }

  Future<bool> _loadMeta(int totalBytes) async {
    final metaFile = File(metaPath);
    final partFile = File(tempPath);
    if (!await metaFile.exists() || !await partFile.exists()) {
      return false;
    }
    try {
      final decoded = jsonDecode(await metaFile.readAsString());
      if (decoded is! Map || decoded['version'] != 1 || decoded['mode'] != 'segmented') {
        return false;
      }
      if (decoded['totalBytes'] != totalBytes || decoded['url'] != _resolvedUrl) {
        return false;
      }
      final rawSegments = decoded['segments'];
      if (rawSegments is! List || rawSegments.isEmpty) {
        return false;
      }
      final segments = rawSegments
          .whereType<Map>()
          .map((item) => DownloadSegment.fromJson(Map<String, dynamic>.from(item)))
          .toList();
      if (!_coversFullFile(segments, totalBytes)) {
        return false;
      }
      final fileLength = await partFile.length();
      if (fileLength < totalBytes) {
        return false;
      }
      _segments = segments;
      _etag = decoded['etag']?.toString() ?? _etag;
      _lastModified = decoded['lastModified']?.toString() ?? _lastModified;
      return true;
    } catch (_) {
      return false;
    }
  }

  List<DownloadSegment> _createSegments(int totalBytes) {
    final count = math.min(
      connections,
      math.max(1, (totalBytes / minSegmentSizeBytes).ceil()),
    );
    final chunkSize = (totalBytes / count).ceil();
    final result = <DownloadSegment>[];
    var start = 0;
    for (var index = 0; index < count && start < totalBytes; index += 1) {
      final end = math.min(totalBytes - 1, start + chunkSize - 1);
      result.add(DownloadSegment(index: index, start: start, end: end));
      start = end + 1;
    }
    return result;
  }

  Future<void> _preallocate(int totalBytes) async {
    await _closeFile();
    final handle = await File(tempPath).open(mode: FileMode.write);
    try {
      await handle.truncate(totalBytes);
    } catch (_) {
      if (totalBytes <= 0) {
        return;
      }
      await handle.setPosition(totalBytes - 1);
      await handle.writeByte(0);
    } finally {
      await handle.close();
    }
  }

  Future<int> _existingLength() async {
    try {
      return await File(tempPath).length();
    } catch (_) {
      return 0;
    }
  }

  Future<void> _closeFile() async {}

  Future<void> _ensureParentDirectories() async {
    final paths = <String>{
      parentPath(filePath),
      parentPath(tempPath),
      parentPath(metaPath),
    };
    for (final path in paths) {
      await Directory(path).create(recursive: true);
    }
  }

  Future<void> _persistMeta({required bool force}) {
    if (!force || _totalBytes == null || _segments.isEmpty || _finalized) {
      return Future<void>.value();
    }
    final next = _metaChain.then<void>((_) async {
      if (_finalized) {
        return;
      }
      await _ensureParentDirectories();
      final payload = <String, dynamic>{
        'version': 1,
        'mode': 'segmented',
        'url': _resolvedUrl,
        'totalBytes': _totalBytes,
        'segments': _segments.map((segment) => segment.toJson()).toList(),
        'etag': _etag,
        'lastModified': _lastModified,
      };
      final temporary = File('$metaPath.tmp');
      await temporary.writeAsString(jsonEncode(payload));
      final target = File(metaPath);
      if (await target.exists()) {
        await target.delete();
      }
      await temporary.rename(metaPath);
    });
    _metaChain = next.then<void>((_) {}, onError: (_) {});
    return next;
  }

  Future<void> _resetPartFiles() async {
    await _closeFile();
    for (final path in <String>[tempPath, metaPath, '$metaPath.tmp']) {
      try {
        final file = File(path);
        if (await file.exists()) {
          await file.delete();
        }
      } catch (_) {
        // A later retry will report the real filesystem error if it persists.
      }
    }
    _segments = <DownloadSegment>[];
    _downloadedBytes = 0;
  }

  Future<void> _validateCompletedFile() async {
    final file = File(tempPath);
    if (!await file.exists()) {
      throw StateError('Temporary download file is missing');
    }
    final length = await file.length();
    if (_totalBytes != null && length != _totalBytes) {
      throw StateError('File size mismatch: expected $_totalBytes bytes, got $length');
    }
  }

  Future<void> _finalizeCompletedDownload() async {
    _finalized = true;
    await _closeFile();
    await _metaChain.catchError((_) {});
    await _ensureParentDirectories();
    final target = File(filePath);
    if (await target.exists()) {
      throw StateError('Destination file already exists: $filePath');
    }
    await File(tempPath).rename(filePath);
    for (final path in <String>[metaPath, '$metaPath.tmp']) {
      try {
        final file = File(path);
        if (await file.exists()) {
          await file.delete();
        }
      } catch (_) {
        // Completion is already safe; stale checkpoints can be removed later.
      }
    }
  }

  Map<String, String> _validatorHeaders() => <String, String>{
        if (_etag != null && !_etag!.startsWith('W/')) 'If-Range': _etag!,
        if (_etag == null && _lastModified != null) 'If-Range': _lastModified!,
      };

  void _emitProgress() {
    final now = DateTime.now();
    final elapsed = now.difference(_lastProgressAt).inMilliseconds;
    final speed = elapsed <= 0
        ? 0
        : math.max(0, ((_downloadedBytes - _lastProgressBytes) * 1000 / elapsed).round());
    if (elapsed >= 200 || _downloadedBytes == 0) {
      _lastProgressAt = now;
      _lastProgressBytes = _downloadedBytes;
    }
    final total = _totalBytes;
    onProgress(
      DownloadProgress(
        id: id,
        downloadedBytes: _downloadedBytes,
        totalBytes: total,
        speedBytesPerSecond: speed,
        percent: total == null || total == 0
            ? 0
            : (_downloadedBytes / total * 100).clamp(0, 100).toDouble(),
        segments: _segments.isEmpty ? null : _segments.map((segment) => segment.copy()).toList(),
      ),
    );
  }

  void _throwIfAborted() {
    final reason = _abortReason;
    if (reason != null) {
      throw DownloadAbortException(reason);
    }
  }
}

class ProbeResult {
  const ProbeResult({
    required this.url,
    required this.supportsRanges,
    required this.totalBytes,
    required this.etag,
    required this.lastModified,
  });

  ProbeResult.empty()
      : url = Uri(),
        supportsRanges = false,
        totalBytes = null,
        etag = null,
        lastModified = null;

  factory ProbeResult.fromResponse(Uri url, HttpClientResponse response, {ProbeResult? fallback}) {
    return ProbeResult(
      url: url,
      supportsRanges: response.statusCode == 206,
      totalBytes: _totalFromResponse(response, 0) ?? fallback?.totalBytes,
      etag: response.headers.value(HttpHeaders.etagHeader) ?? fallback?.etag,
      lastModified: response.headers.value(HttpHeaders.lastModifiedHeader) ?? fallback?.lastModified,
    );
  }

  final Uri url;
  final bool supportsRanges;
  final int? totalBytes;
  final String? etag;
  final String? lastModified;

  ProbeResult copyWith({Uri? url, bool? supportsRanges}) => ProbeResult(
        url: url ?? this.url,
        supportsRanges: supportsRanges ?? this.supportsRanges,
        totalBytes: totalBytes,
        etag: etag,
        lastModified: lastModified,
      );
}

bool _coversFullFile(List<DownloadSegment> segments, int totalBytes) {
  final ordered = [...segments]..sort((a, b) => a.start.compareTo(b.start));
  var expected = 0;
  for (final segment in ordered) {
    if (segment.start != expected || segment.end < segment.start || segment.end >= totalBytes) {
      return false;
    }
    segment.downloaded = segment.downloaded.clamp(0, segment.length).toInt();
    expected = segment.end + 1;
  }
  return expected == totalBytes;
}

int? _totalFromResponse(HttpClientResponse response, int offset) {
  final contentRange = response.headers.value(HttpHeaders.contentRangeHeader);
  if (contentRange != null) {
    final match = RegExp(r'/([0-9]+)$').firstMatch(contentRange);
    if (match != null) {
      return int.tryParse(match.group(1)!);
    }
  }
  final length = response.contentLength;
  return length >= 0 ? length + offset : null;
}

bool _isRetryable(Object error) {
  if (error is DownloadHttpException) {
    return error.statusCode == 408 ||
        error.statusCode == 425 ||
        error.statusCode == 429 ||
        error.statusCode >= 500;
  }
  if (error is SocketException) {
    return true;
  }
  if (error is HttpException) {
    return true;
  }
  final message = error.toString().toLowerCase();
  return message.contains('timed out') ||
      message.contains('connection closed') ||
      message.contains('socket hang up');
}

Duration _retryDelay(int attempt) => Duration(milliseconds: math.min(8000, 300 * math.pow(2, attempt - 1).toInt()));
