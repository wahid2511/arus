import 'dart:convert';
import 'dart:io';

import '../core/path_utils.dart';
import '../models/download_models.dart';

class AppStorage {
  AppStorage({Directory? root}) : root = root ?? Directory(appDataDirectory());

  final Directory root;

  File get tasksFile => File(joinPath(root.path, 'arus-downloads.json'));
  File get settingsFile => File(joinPath(root.path, 'arus-settings.json'));

  Future<void> prepare() => root.create(recursive: true);

  Future<List<DownloadTask>> loadTasks() async {
    try {
      if (!await tasksFile.exists()) {
        return <DownloadTask>[];
      }
      final decoded = jsonDecode(await tasksFile.readAsString());
      if (decoded is! List) {
        return <DownloadTask>[];
      }
      return decoded
          .whereType<Map>()
          .map((item) => DownloadTask.fromJson(Map<String, dynamic>.from(item)))
          .where((task) => task.url.isNotEmpty && task.filePath.isNotEmpty)
          .toList();
    } catch (_) {
      return <DownloadTask>[];
    }
  }

  Future<void> saveTasks(Iterable<DownloadTask> tasks) async {
    await prepare();
    final payload = tasks.map((task) => task.toJson()).toList();
    await tasksFile.writeAsString(const JsonEncoder.withIndent('  ').convert(payload));
  }

  Future<DownloadSettings> loadSettings() async {
    try {
      if (!await settingsFile.exists()) {
        return const DownloadSettings();
      }
      final decoded = jsonDecode(await settingsFile.readAsString());
      return decoded is Map
          ? DownloadSettings.fromJson(Map<String, dynamic>.from(decoded))
          : const DownloadSettings();
    } catch (_) {
      return const DownloadSettings();
    }
  }

  Future<void> saveSettings(DownloadSettings settings) async {
    await prepare();
    await settingsFile.writeAsString(const JsonEncoder.withIndent('  ').convert(settings.toJson()));
  }
}
