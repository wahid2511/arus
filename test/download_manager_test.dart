import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/src/core/path_utils.dart';
import 'package:arus_flutter/src/services/app_storage.dart';
import 'package:arus_flutter/src/services/download_manager.dart';

void main() {
  test(
    'repairs an oversized legacy path before a failed task is retried',
    () async {
      final root = await Directory.systemTemp.createTemp(
        'arus-path-repair-test-',
      );
      final stateRoot = Directory(joinPath(root.path, 'state'));
      final downloadRoot = joinPath(root.path, 'Downloads');
      final longName = '${List<String>.filled(400, 'A').join()}.zip';
      final oldPath = joinPath(downloadRoot, longName);

      try {
        await stateRoot.create(recursive: true);
        await File(
          joinPath(stateRoot.path, 'arus-downloads.json'),
        ).writeAsString(
          jsonEncode(<Map<String, dynamic>>[
            <String, dynamic>{
              'id': 'legacy-task',
              'url': 'https://example.test/$longName',
              'fileName': longName,
              'filePath': oldPath,
              'directory': downloadRoot,
              'status': 'failed',
              'createdAt': DateTime.now().millisecondsSinceEpoch,
            },
          ]),
        );

        final manager = DownloadManager(storage: AppStorage(root: stateRoot));
        await manager.init();

        final task = manager.tasks.single;
        expect(
          task.fileName.length,
          lessThanOrEqualTo(maxSafeFileNameLength(downloadRoot)),
        );
        expect(task.filePath, joinPath(downloadRoot, task.fileName));
        expect(task.filePath, isNot(oldPath));

        manager.dispose();
      } finally {
        await root.delete(recursive: true);
      }
    },
  );

  test('shortens an opaque proxy filename when loading an old queue', () async {
    final root = await Directory.systemTemp.createTemp(
      'arus-proxy-name-repair-test-',
    );
    final stateRoot = Directory(joinPath(root.path, 'state'));
    final downloadRoot = joinPath(root.path, 'Downloads');
    final token = List<String>.filled(240, 'A').join();
    final oldPath = joinPath(downloadRoot, token);

    try {
      await stateRoot.create(recursive: true);
      await File(
        joinPath(stateRoot.path, 'arus-downloads.json'),
      ).writeAsString(
        jsonEncode(<Map<String, dynamic>>[
          <String, dynamic>{
            'id': 'proxy-task',
            'url': 'https://proxy.example/download/$token',
            'fileName': token,
            'filePath': oldPath,
            'directory': downloadRoot,
            'status': 'paused',
            'createdAt': DateTime.now().millisecondsSinceEpoch,
          },
        ]),
      );

      final manager = DownloadManager(storage: AppStorage(root: stateRoot));
      await manager.init();

      final task = manager.tasks.single;
      expect(task.fileName, 'download.bin');
      expect(task.filePath, joinPath(downloadRoot, 'download.bin'));

      manager.dispose();
    } finally {
      await root.delete(recursive: true);
    }
  });

  test('removing a task keeps the completed download file', () async {
    final root = await Directory.systemTemp.createTemp(
      'arus-remove-task-test-',
    );
    final stateRoot = Directory(joinPath(root.path, 'state'));
    final downloadRoot = joinPath(root.path, 'Downloads');
    final finalPath = joinPath(downloadRoot, 'compiled-marker.exe');

    try {
      await stateRoot.create(recursive: true);
      await Directory(downloadRoot).create(recursive: true);
      await File(finalPath).writeAsString('keep this file');
      await File(
        joinPath(stateRoot.path, 'arus-downloads.json'),
      ).writeAsString(
        jsonEncode(<Map<String, dynamic>>[
          <String, dynamic>{
            'id': 'completed-task',
            'url': 'https://example.test/compiled-marker.exe',
            'fileName': 'compiled-marker.exe',
            'filePath': finalPath,
            'directory': downloadRoot,
            'status': 'completed',
            'progress': 1,
            'bytesReceived': 14,
            'totalBytes': 14,
            'createdAt': DateTime.now().millisecondsSinceEpoch,
          },
        ]),
      );

      final manager = DownloadManager(storage: AppStorage(root: stateRoot));
      await manager.init();
      await manager.remove('completed-task');

      expect(manager.tasks, isEmpty);
      expect(await File(finalPath).exists(), isTrue);
      expect(await File(finalPath).readAsString(), 'keep this file');
      manager.dispose();
    } finally {
      await root.delete(recursive: true);
    }
  });
}
