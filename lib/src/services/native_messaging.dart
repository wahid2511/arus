import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import '../core/path_utils.dart';
import 'download_manager.dart';

const String nativeHostName = 'com.arus.app';
const String chromeExtensionId = 'pnmkpgoolmmekpecphmakboegpajanmc';
const String firefoxExtensionId = 'arus@arus.app';

/// Local authenticated bridge used by the browser's Native Messaging host.
///
/// The bridge binds only to loopback and publishes a random token in the
/// per-user Arus data directory. The browser-facing process reads that file,
/// forwards one framed message at a time, and never opens a public port.
class NativeBridgeServer {
  NativeBridgeServer({required this.manager});

  final DownloadManager manager;
  ServerSocket? _server;
  String? _token;
  File? _endpointFile;

  bool get isRunning => _server != null;

  Future<void> start() async {
    if (_server != null) {
      return;
    }
    final directory = Directory(appDataDirectory());
    await directory.create(recursive: true);
    final token = _newToken();
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    _token = token;
    _endpointFile = File(joinPath(directory.path, 'native-bridge.json'));
    await _endpointFile!.writeAsString(
      jsonEncode(<String, dynamic>{
        'port': server.port,
        'token': token,
        'pid': pid,
      }),
    );
    server.listen(_serveSocket);
  }

  Future<void> _serveSocket(Socket socket) async {
    try {
      await for (final line
          in socket
              .cast<List<int>>()
              .transform(utf8.decoder)
              .transform(const LineSplitter())) {
        if (line.trim().isEmpty) {
          continue;
        }
        Map<String, dynamic> envelope;
        try {
          final decoded = jsonDecode(line);
          envelope = decoded is Map
              ? Map<String, dynamic>.from(decoded)
              : <String, dynamic>{};
        } catch (_) {
          envelope = <String, dynamic>{};
        }
        final response = await _handleEnvelope(envelope);
        socket.write('${jsonEncode(response)}\n');
        await socket.flush();
      }
    } catch (_) {
      // A browser can close the native host connection while a response is
      // being written. The next request will establish a new socket.
    } finally {
      await socket.close();
    }
  }

  Future<Map<String, dynamic>> _handleEnvelope(
    Map<String, dynamic> envelope,
  ) async {
    if (envelope['token'] != _token) {
      return <String, dynamic>{
        'type': 'error',
        'ok': false,
        'error': 'Invalid Arus bridge token',
      };
    }
    final request = envelope['request'];
    if (request is! Map) {
      return <String, dynamic>{
        'type': 'error',
        'ok': false,
        'error': 'Invalid native request',
      };
    }
    final payload = Map<String, dynamic>.from(request);
    switch (payload['type']?.toString()) {
      case 'ping':
        return <String, dynamic>{
          'type': 'pong',
          'ok': true,
          'version': '1.0.0',
          'app': 'Arus',
        };
      case 'download':
        if (!manager.settings.browserIntegrationEnabled) {
          return <String, dynamic>{
            'type': 'error',
            'ok': false,
            'error': 'Browser integration is disabled in Arus settings',
          };
        }
        final url = payload['url']?.toString().trim() ?? '';
        if (!isSupportedUrl(url)) {
          return <String, dynamic>{
            'type': 'error',
            'ok': false,
            'error': 'Only HTTP, HTTPS, and FTP URLs are supported',
          };
        }
        final rawHeaders = payload['headers'];
        final headers = <String, String>{
          if (rawHeaders is Map)
            ...Map<String, String>.from(
              rawHeaders.map(
                (key, value) => MapEntry(key.toString(), value.toString()),
              ),
            ),
        };
        final cookie = payload['cookie']?.toString();
        if (cookie != null && cookie.isNotEmpty) {
          headers['Cookie'] = cookie;
        }
        final task = await manager.add(
          url: url,
          fileName: payload['fileName']?.toString(),
          headers: headers.isEmpty ? null : headers,
        );
        return <String, dynamic>{
          'type': 'download-pending',
          'ok': true,
          'id': task.id,
        };
      default:
        return <String, dynamic>{
          'type': 'error',
          'ok': false,
          'error': 'Unknown native request',
        };
    }
  }

  Future<void> stop() async {
    final server = _server;
    _server = null;
    _token = null;
    await server?.close();
    final endpoint = _endpointFile;
    _endpointFile = null;
    if (endpoint != null) {
      try {
        final decoded = jsonDecode(await endpoint.readAsString());
        if (decoded is Map && decoded['pid'] == pid) {
          await endpoint.delete();
        }
      } catch (_) {
        // The file may already have been removed by a newer app instance.
      }
    }
  }
}

/// Entry point for a compiled Arus executable registered as a Native
/// Messaging host. It translates Chrome/Firefox's 4-byte framed stdin into
/// requests for the GUI instance's loopback bridge.
Future<void> runNativeMessagingHost() async {
  final reader = _NativeMessageReader(stdin);
  while (true) {
    final header = await reader.readExact(4);
    if (header == null) {
      return;
    }
    final length = ByteData.sublistView(
      Uint8List.fromList(header),
    ).getUint32(0, Endian.little);
    if (length <= 0 || length > 16 * 1024 * 1024) {
      await _writeNativeResponse(<String, dynamic>{
        'type': 'error',
        'ok': false,
        'error': 'Invalid native message length',
      });
      return;
    }
    final body = await reader.readExact(length);
    if (body == null) {
      return;
    }
    Map<String, dynamic> request;
    try {
      final decoded = jsonDecode(utf8.decode(body));
      request = decoded is Map
          ? Map<String, dynamic>.from(decoded)
          : <String, dynamic>{};
    } catch (_) {
      request = <String, dynamic>{};
    }
    final response = await _forwardToGui(request);
    await _writeNativeResponse(response);
  }
}

Future<Map<String, dynamic>> _forwardToGui(Map<String, dynamic> request) async {
  try {
    final endpoint = File(joinPath(appDataDirectory(), 'native-bridge.json'));
    final decoded = jsonDecode(await endpoint.readAsString());
    if (decoded is! Map ||
        decoded['port'] is! num ||
        decoded['token'] == null) {
      throw const FormatException('Invalid Arus bridge endpoint');
    }
    final socket = await Socket.connect(
      InternetAddress.loopbackIPv4,
      (decoded['port'] as num).toInt(),
      timeout: const Duration(seconds: 3),
    );
    try {
      socket.write(
        '${jsonEncode(<String, dynamic>{'token': decoded['token'], 'request': request})}\n',
      );
      await socket.flush();
      final lines = socket
          .cast<List<int>>()
          .transform(utf8.decoder)
          .transform(const LineSplitter());
      final response = await lines.first.timeout(const Duration(seconds: 8));
      final parsed = jsonDecode(response);
      return parsed is Map
          ? Map<String, dynamic>.from(parsed)
          : <String, dynamic>{
              'type': 'error',
              'ok': false,
              'error': 'Invalid Arus response',
            };
    } finally {
      await socket.close();
    }
  } catch (error) {
    return <String, dynamic>{
      'type': 'error',
      'ok': false,
      'error':
          'Arus is not running or the native bridge is unavailable: $error',
    };
  }
}

Future<void> _writeNativeResponse(Map<String, dynamic> response) async {
  final body = Uint8List.fromList(utf8.encode(jsonEncode(response)));
  final header = ByteData(4)..setUint32(0, body.length, Endian.little);
  stdout.add(header.buffer.asUint8List());
  stdout.add(body);
  await stdout.flush();
}

class _NativeMessageReader {
  _NativeMessageReader(Stream<List<int>> input)
    : _iterator = StreamIterator<List<int>>(input);

  final StreamIterator<List<int>> _iterator;
  final List<int> _buffer = <int>[];

  Future<List<int>?> readExact(int length) async {
    while (_buffer.length < length) {
      if (!await _iterator.moveNext()) {
        if (_buffer.isEmpty) {
          return null;
        }
        throw const FormatException('Truncated native message');
      }
      _buffer.addAll(_iterator.current);
    }
    final result = _buffer.sublist(0, length);
    _buffer.removeRange(0, length);
    return result;
  }
}

bool isSupportedUrl(String value) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      const <String>{
        'http',
        'https',
        'ftp',
      }.contains(uri.scheme.toLowerCase()) &&
      uri.host.isNotEmpty;
}

String _newToken() {
  final random = math.Random.secure();
  return List<String>.generate(
    32,
    (_) => random.nextInt(16).toRadixString(16),
  ).join();
}
