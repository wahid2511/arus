import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/src/core/path_utils.dart';

void main() {
  test('bounds long URL-derived names while preserving a short extension', () {
    final longName = '${List<String>.filled(400, 'A').join()}.zip';
    final safe = safeFileName(longName);

    expect(safe.length, lessThanOrEqualTo(120));
    expect(safe, endsWith('.zip'));
  });

  test('reserves room for temporary and metadata files', () {
    final directory = r'C:\Users\GENGHERO\Downloads';
    final safe = safeFileNameForDirectory(
      List<String>.filled(500, 'A').join(),
      directory,
    );

    expect(safe.length, lessThanOrEqualTo(maxSafeFileNameLength(directory)));
  });

  test('avoids Windows device names', () {
    expect(safeFileName('CON.txt'), '_CON.txt');
  });

  test('replaces opaque proxy URL tokens with a short fallback name', () {
    final token = List<String>.filled(240, 'A').join();

    expect(
      nameFromUrl('https://proxy.example/download/$token'),
      'download.bin',
    );
    expect(
      nameFromUrl('https://example.test/files/video.mp4'),
      'video.mp4',
    );
  });

  test('reads both Content-Disposition filename formats', () {
    expect(
      fileNameFromContentDisposition(
        'attachment; filename="video final.mp4"',
      ),
      'video final.mp4',
    );
    expect(
      fileNameFromContentDisposition(
        "attachment; filename*=UTF-8''video%20final.mp4",
      ),
      'video final.mp4',
    );
  });

  test('keeps byte and speed units aligned', () {
    expect(formatBytes(1024), '1.0 KB');
    expect(formatBytes(1024 * 1024), '1.0 MB');
    expect(formatBytes(756789294), '722 MB');
    expect(formatSpeed(1024 * 1024), '1.0 MB/s');
  });
}
