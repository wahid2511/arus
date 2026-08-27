import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/src/core/path_utils.dart';
import 'package:arus_flutter/src/services/segmented_downloader.dart';

void main() {
  test('downloads a byte-identical segmented file into a missing directory', () async {
    final bytes = List<int>.generate(96 * 1024, (index) => (index * 31) % 251);
    final server = await _serve(bytes, supportsRanges: true);
    final root = await Directory.systemTemp.createTemp('arus-segmented-test-');
    final target = joinPath(joinPath(root.path, 'nested', 'folder'), 'sample.bin');

    try {
      final downloader = SegmentedDownloader(
        id: 'test-segmented',
        url: 'http://127.0.0.1:${server.port}/sample.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        connections: 4,
        minSegmentSizeBytes: 8 * 1024,
        maxRetries: 2,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File(target).exists(), isTrue);
      expect(await File('$target.part').exists(), isFalse);
      expect(await File('$target.part.meta.json').exists(), isFalse);
    } finally {
      await server.close(force: true);
      await root.delete(recursive: true);
    }
  });

  test('resumes a previous segmented checkpoint and removes it after assembly', () async {
    final bytes = List<int>.generate(96 * 1024, (index) => (index * 13) % 239);
    final server = await _serve(bytes, supportsRanges: true);
    final root = await Directory.systemTemp.createTemp('arus-resume-test-');
    final target = joinPath(root.path, 'resume.bin');
    final half = bytes.length ~/ 2;
    final part = List<int>.filled(bytes.length, 0);
    part.setRange(0, half, bytes, 0);

    try {
      await File('$target.part').create(recursive: true);
      await File('$target.part').writeAsBytes(part);
      await File('$target.part.meta.json').writeAsString(
        jsonEncode(<String, dynamic>{
          'version': 2,
          'mode': 'segmented',
          'url': 'http://127.0.0.1:${server.port}/resume.bin',
          'totalBytes': bytes.length,
          'segments': <Map<String, int>>[
            <String, int>{'index': 0, 'start': 0, 'end': half - 1, 'downloaded': half},
            <String, int>{'index': 1, 'start': half, 'end': bytes.length - 1, 'downloaded': 0},
          ],
        }),
      );

      final downloader = SegmentedDownloader(
        id: 'test-resume',
        url: 'http://127.0.0.1:${server.port}/resume.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        connections: 4,
        minSegmentSizeBytes: half,
        maxRetries: 2,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File('$target.part.meta.json').exists(), isFalse);
    } finally {
      await server.close(force: true);
      await root.delete(recursive: true);
    }
  });

  test('falls back to a single stream when the server ignores ranges', () async {
    final bytes = List<int>.generate(20 * 1024, (index) => index % 199);
    final server = await _serve(bytes, supportsRanges: false);
    final root = await Directory.systemTemp.createTemp('arus-single-test-');
    final target = joinPath(root.path, 'single.bin');

    try {
      final downloader = SegmentedDownloader(
        id: 'test-single',
        url: 'http://127.0.0.1:${server.port}/single.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        connections: 8,
        minSegmentSizeBytes: 4 * 1024,
        maxRetries: 1,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File('$target.part').exists(), isFalse);
      expect(await File('$target.part.meta.json').exists(), isFalse);
    } finally {
      await server.close(force: true);
      await root.delete(recursive: true);
    }
  });

  test('rebuilds successfully when Range support disappears after the probe', () async {
    final bytes = List<int>.generate(128 * 1024, (index) => (index * 23) % 241);
    final server = await _serveRangeLoss(bytes);
    final root = await Directory.systemTemp.createTemp('arus-range-loss-test-');
    final target = joinPath(root.path, 'range-loss.bin');

    try {
      final downloader = SegmentedDownloader(
        id: 'test-range-loss',
        url: 'http://127.0.0.1:${server.port}/range-loss.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        connections: 4,
        minSegmentSizeBytes: 8 * 1024,
        maxRetries: 2,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File('$target.part').exists(), isFalse);
      expect(await File('$target.part.meta.json').exists(), isFalse);
    } finally {
      await server.close(force: true);
      await root.delete(recursive: true);
    }
  });

  test('retries a dropped single stream and resumes the partial file', () async {
    final bytes = List<int>.generate(48 * 1024, (index) => (index * 17) % 233);
    final server = await _serveWithDrop(bytes);
    final root = await Directory.systemTemp.createTemp('arus-retry-test-');
    final target = joinPath(root.path, 'retry.bin');

    try {
      final downloader = SegmentedDownloader(
        id: 'test-retry',
        url: 'http://127.0.0.1:${server.port}/retry.bin',
        filePath: target,
        tempPath: '$target.part',
        metaPath: '$target.part.meta.json',
        connections: 8,
        minSegmentSizeBytes: 4 * 1024,
        maxRetries: 2,
        onProgress: (_) {},
      );

      await downloader.start();

      expect(await File(target).readAsBytes(), bytes);
      expect(await File('$target.part').exists(), isFalse);
      expect(await File('$target.part.meta.json').exists(), isFalse);
    } finally {
      await server.close(force: true);
      await root.delete(recursive: true);
    }
  });
}

Future<HttpServer> _serve(List<int> bytes, {required bool supportsRanges}) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    final response = request.response;
    response.headers.set(HttpHeaders.etagHeader, '"arus-test"');

    if (request.method == 'HEAD') {
      response.statusCode = HttpStatus.ok;
      response.contentLength = bytes.length;
      await response.close();
      return;
    }

    final range = request.headers.value(HttpHeaders.rangeHeader);
    if (supportsRanges && range != null) {
      final match = RegExp(r'bytes=(\d+)-(\d+)?').firstMatch(range);
      if (match != null) {
        final start = int.parse(match.group(1)!);
        final requestedEnd = match.group(2) == null ? bytes.length - 1 : int.parse(match.group(2)!);
        final end = requestedEnd.clamp(start, bytes.length - 1).toInt();
        response.statusCode = HttpStatus.partialContent;
        response.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/${bytes.length}');
        response.contentLength = end - start + 1;
        response.add(bytes.sublist(start, end + 1));
        await response.close();
        return;
      }
    }

    response.statusCode = HttpStatus.ok;
    response.contentLength = bytes.length;
    response.add(bytes);
    await response.close();
  });
  return server;
}

Future<HttpServer> _serveWithDrop(List<int> bytes) async {
  var dropped = false;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  server.listen((request) async {
    final response = request.response;
    response.headers.set(HttpHeaders.etagHeader, '"arus-retry"');

    if (request.method == 'HEAD') {
      response.statusCode = HttpStatus.ok;
      response.contentLength = bytes.length;
      await response.close();
      return;
    }

    final range = request.headers.value(HttpHeaders.rangeHeader);
    final match = range == null ? null : RegExp(r'bytes=(\d+)-').firstMatch(range);
    final start = match == null ? 0 : int.parse(match.group(1)!);

    if (range != null && start > 0) {
      response.statusCode = HttpStatus.partialContent;
      response.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-${bytes.length - 1}/${bytes.length}');
      response.contentLength = bytes.length - start;
      response.add(bytes.sublist(start));
      await response.close();
      return;
    }

    response.statusCode = HttpStatus.ok;
    if (!dropped) {
      dropped = true;
      response.contentLength = -1;
      response.add(bytes.sublist(0, bytes.length ~/ 2));
    } else {
      response.contentLength = bytes.length;
      response.add(bytes);
    }
    await response.close();
  });
  return server;
}

Future<HttpServer> _serveRangeLoss(List<int> bytes) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  var probeSeen = false;
  server.listen((request) async {
    final response = request.response;
    response.headers.set(HttpHeaders.etagHeader, '"arus-range-loss"');

    if (request.method == 'HEAD') {
      response.statusCode = HttpStatus.ok;
      response.contentLength = bytes.length;
      await response.close();
      return;
    }

    final range = request.headers.value(HttpHeaders.rangeHeader);
    if (range == 'bytes=0-0' && !probeSeen) {
      probeSeen = true;
      response.statusCode = HttpStatus.partialContent;
      response.headers.set(HttpHeaders.contentRangeHeader, 'bytes 0-0/${bytes.length}');
      response.contentLength = 1;
      response.add(<int>[bytes.first]);
      await response.close();
      return;
    }

    if (range != null) {
      response.statusCode = HttpStatus.forbidden;
      response.contentLength = 0;
      await response.close();
      return;
    }

    response.statusCode = HttpStatus.ok;
    response.contentLength = bytes.length;
    response.add(bytes);
    await response.close();
  });
  return server;
}
