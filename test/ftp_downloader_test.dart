import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/src/core/path_utils.dart';
import 'package:arus_flutter/src/services/ftp_downloader.dart';

void main() {
  test('downloads a passive FTP file into the final path', () async {
    final bytes = List<int>.generate(32 * 1024, (index) => (index * 19) % 241);
    final server = await _FtpTestServer.start(bytes);
    final root = await Directory.systemTemp.createTemp('arus-ftp-test-');
    final target = joinPath(root.path, 'ftp.bin');

    try {
      final downloader = FtpDownloader(
        id: 'ftp-test',
        url: 'ftp://127.0.0.1:${server.port}/sample.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        maxRetries: 1,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File('$target.part').exists(), isFalse);
    } finally {
      await server.close();
      await root.delete(recursive: true);
    }
  });
}

class _FtpTestServer {
  _FtpTestServer(this._control, this._bytes);

  final ServerSocket _control;
  final List<int> _bytes;
  final List<Socket> _connections = <Socket>[];

  int get port => _control.port;

  static Future<_FtpTestServer> start(List<int> bytes) async {
    final control = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final server = _FtpTestServer(control, bytes);
    control.listen(server._handleConnection);
    return server;
  }

  Future<void> _handleConnection(Socket socket) async {
    _connections.add(socket);
    ServerSocket? passive;
    var offset = 0;
    try {
      await _write(socket, '220 Arus test FTP\r\n');
      await for (final line
          in socket
              .cast<List<int>>()
              .transform(utf8.decoder)
              .transform(const LineSplitter())) {
        final command = line.trim().split(' ').first.toUpperCase();
        switch (command) {
          case 'USER':
            await _write(socket, '331 Password required\r\n');
          case 'PASS':
            await _write(socket, '230 Logged in\r\n');
          case 'TYPE':
            await _write(socket, '200 Type set\r\n');
          case 'SIZE':
            await _write(socket, '213 ${_bytes.length}\r\n');
          case 'REST':
            offset = int.tryParse(line.substring(4).trim()) ?? 0;
            await _write(socket, '350 Restart accepted\r\n');
          case 'EPSV':
            await passive?.close();
            passive = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
            await _write(
              socket,
              '229 Entering Extended Passive Mode (|||${passive.port}|)\r\n',
            );
          case 'RETR':
            final dataServer = passive;
            if (dataServer == null) {
              await _write(socket, '425 Use EPSV first\r\n');
              continue;
            }
            await _write(socket, '150 Opening binary data connection\r\n');
            final data = await dataServer.first;
            await data.addStream(
              Stream<List<int>>.value(_bytes.sublist(offset)),
            );
            await data.close();
            await dataServer.close();
            passive = null;
            await _write(socket, '226 Transfer complete\r\n');
          default:
            await _write(socket, '200 OK\r\n');
        }
      }
    } finally {
      await passive?.close();
      _connections.remove(socket);
      await socket.close();
    }
  }

  static Future<void> _write(Socket socket, String value) async {
    socket.write(value);
    await socket.flush();
  }

  Future<void> close() async {
    await _control.close();
    for (final socket in List<Socket>.from(_connections)) {
      socket.destroy();
    }
  }
}
