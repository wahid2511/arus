import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../core/path_utils.dart';
import '../models/download_models.dart';
import 'app_storage.dart';
import 'segmented_downloader.dart';

class DownloadManager extends ChangeNotifier {
  DownloadManager({AppStorage? storage}) : _storage = storage ?? AppStorage();

  final AppStorage _storage;
  final List<DownloadTask> _tasks = <DownloadTask>[];
  final Map<String, SegmentedDownloader> _active = <String, SegmentedDownloader>{};
  final Set<String> _starting = <String>{};
  DownloadSettings _settings = const DownloadSettings();
  Timer? _persistTimer;
  bool _ready = false;

  bool get ready => _ready;
  DownloadSettings get settings => _settings;
  List<DownloadTask> get tasks => List<DownloadTask>.unmodifiable(_tasks);
  String get defaultDirectory => defaultDownloadDirectory();

  Future<void> init() async {
    await _storage.prepare();
    _settings = await _storage.loadSettings();
    _tasks
      ..clear()
      ..addAll(await _storage.loadTasks());
    for (final task in _tasks) {
      if (task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued) {
        task.status = DownloadStatus.paused;
        task.speedBytesPerSecond = 0;
      }
      task.segments = task.segments?.map((segment) => segment..active = false).toList();
    }
    _ready = true;
    notifyListeners();
  }

  Future<DownloadTask> add({
    required String url,
    String? directory,
    String? fileName,
    Map<String, String>? headers,
  }) async {
    final normalizedUrl = _normalizeUrl(url);
    final targetDirectory = directory?.trim().isNotEmpty == true
        ? directory!.trim()
        : defaultDirectory;
    await Directory(targetDirectory).create(recursive: true);

    final preferredName = safeFileName(
      fileName?.trim().isNotEmpty == true ? fileName!.trim() : nameFromUrl(normalizedUrl),
    );
    final reserved = _tasks.map((task) => task.filePath);
    final path = uniqueFilePath(targetDirectory, preferredName, reserved: reserved);
    final task = DownloadTask(
      id: _newId(),
      url: normalizedUrl,
      fileName: baseName(path),
      filePath: path,
      directory: targetDirectory,
      createdAt: DateTime.now(),
      headers: headers == null ? null : <String, String>{...headers},
    );
    _tasks.insert(0, task);
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
    return task.snapshot();
  }

  Future<void> pause(String id) async {
    final task = _task(id);
    if (task.status == DownloadStatus.queued) {
      task.status = DownloadStatus.paused;
    } else if (task.status == DownloadStatus.downloading) {
      _active[id]?.pause();
      task.status = DownloadStatus.paused;
      task.speedBytesPerSecond = 0;
    }
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> resume(String id) async {
    final task = _task(id);
    if (task.status != DownloadStatus.paused &&
        task.status != DownloadStatus.failed &&
        task.status != DownloadStatus.cancelled) {
      return;
    }
    if (task.status == DownloadStatus.cancelled) {
      task.bytesReceived = 0;
      task.progress = 0;
      task.totalBytes = null;
      task.segments = null;
      await _deletePartFiles(task);
    }
    task.error = null;
    task.speedBytesPerSecond = 0;
    task.status = DownloadStatus.queued;
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> cancel(String id) async {
    final task = _task(id);
    _active[id]?.cancel();
    task.status = DownloadStatus.cancelled;
    task.speedBytesPerSecond = 0;
    await _deletePartFiles(task);
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> remove(String id) async {
    final task = _task(id);
    if (task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued) {
      await cancel(id);
    } else {
      await _deletePartFiles(task);
    }
    _tasks.removeWhere((item) => item.id == id);
    await _persistNow();
    notifyListeners();
  }

  Future<void> pauseAll() async {
    final ids = _tasks
        .where((task) => task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued)
        .map((task) => task.id)
        .toList();
    await pauseMany(ids);
  }

  Future<void> pauseMany(Iterable<String> ids) async {
    for (final id in ids) {
      await pause(id);
    }
  }

  Future<void> resumeMany(Iterable<String> ids) async {
    for (final id in ids) {
      await resume(id);
    }
  }

  Future<void> removeCompleted() async {
    final ids = _tasks.where((task) => task.status == DownloadStatus.completed).map((task) => task.id).toList();
    for (final id in ids) {
      await remove(id);
    }
  }

  Future<void> revealInFolder(String id) async {
    final task = _task(id);
    if (Platform.isWindows) {
      await Process.start('explorer.exe', <String>['/select,${task.filePath}']);
    } else if (Platform.isMacOS) {
      await Process.start('open', <String>['-R', task.filePath]);
    } else {
      await Process.start('xdg-open', <String>[task.directory]);
    }
  }

  Future<void> updateSettings({
    int? connections,
    int? maxConcurrentDownloads,
    int? minSegmentSizeBytes,
    int? maxSegmentRetries,
    bool? revealOnComplete,
    bool? browserIntegrationEnabled,
    bool? launchAtLogin,
  }) async {
    _settings = _settings.copyWith(
      connections: connections?.clamp(4, 16).toInt(),
      maxConcurrentDownloads: maxConcurrentDownloads?.clamp(1, 10).toInt(),
      minSegmentSizeBytes: minSegmentSizeBytes?.clamp(64 * 1024, 8 * 1024 * 1024).toInt(),
      maxSegmentRetries: maxSegmentRetries?.clamp(0, 10).toInt(),
      revealOnComplete: revealOnComplete,
      browserIntegrationEnabled: browserIntegrationEnabled,
      launchAtLogin: launchAtLogin,
    );
    await _storage.saveSettings(_settings);
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> _pump() async {
    if (!_ready) {
      return;
    }
    final freeSlots = _settings.maxConcurrentDownloads - _active.length - _starting.length;
    if (freeSlots <= 0) {
      return;
    }
    final queued = _tasks
        .where((task) => task.status == DownloadStatus.queued)
        .take(freeSlots)
        .toList();
    for (final task in queued) {
      unawaited(_start(task));
    }
  }

  Future<void> _start(DownloadTask task) async {
    if (task.status != DownloadStatus.queued || !_starting.add(task.id)) {
      return;
    }
    task.status = DownloadStatus.downloading;
    task.error = null;
    task.speedBytesPerSecond = 0;
    notifyListeners();

    try {
      await Directory(parentPath(task.filePath)).create(recursive: true);
      if (task.status != DownloadStatus.downloading) {
        return;
      }
      final downloader = SegmentedDownloader(
        id: task.id,
        url: task.url,
        filePath: task.filePath,
        tempPath: task.tempPath,
        metaPath: task.metaPath,
        connections: _settings.connections,
        minSegmentSizeBytes: _settings.minSegmentSizeBytes,
        maxRetries: _settings.maxSegmentRetries,
        requestHeaders: task.headers,
        onProgress: (progress) => _handleProgress(task, progress),
      );
      _active[task.id] = downloader;
      await downloader.start();
      if (task.status != DownloadStatus.downloading) {
        return;
      }
      task.status = DownloadStatus.completed;
      task.progress = 100;
      task.bytesReceived = task.totalBytes ?? task.bytesReceived;
      task.speedBytesPerSecond = 0;
      task.segments = null;
      await _deletePartFiles(task);
    } on DownloadAbortException catch (error) {
      if (error.reason == 'paused' || task.status == DownloadStatus.paused) {
        task.status = DownloadStatus.paused;
      } else if (task.status != DownloadStatus.cancelled) {
        task.status = DownloadStatus.cancelled;
      }
      task.speedBytesPerSecond = 0;
    } catch (error) {
      if (task.status != DownloadStatus.paused && task.status != DownloadStatus.cancelled) {
        task.status = DownloadStatus.failed;
        task.error = _errorMessage(error);
        task.speedBytesPerSecond = 0;
      }
    } finally {
      _active.remove(task.id);
      _starting.remove(task.id);
      await _persistNow();
      notifyListeners();
      unawaited(_pump());
    }
  }

  void _handleProgress(DownloadTask task, DownloadProgress progress) {
    if (task.status != DownloadStatus.downloading) {
      return;
    }
    task.bytesReceived = progress.downloadedBytes;
    task.totalBytes = progress.totalBytes;
    task.progress = progress.percent;
    task.speedBytesPerSecond = progress.speedBytesPerSecond;
    task.segments = progress.segments;
    notifyListeners();
    _schedulePersist();
  }

  DownloadTask _task(String id) {
    return _tasks.firstWhere(
      (task) => task.id == id,
      orElse: () => throw StateError('Download task not found'),
    );
  }

  Future<void> _deletePartFiles(DownloadTask task) async {
    for (final path in <String>[task.tempPath, task.metaPath, '${task.metaPath}.tmp']) {
      try {
        final file = File(path);
        if (await file.exists()) {
          await file.delete();
        }
      } catch (_) {
        // Ignore cleanup failures; a future resume can still recover the file.
      }
    }
  }

  Future<void> _persistNow() async {
    _persistTimer?.cancel();
    _persistTimer = null;
    await _storage.saveTasks(_tasks);
  }

  void _schedulePersist() {
    if (_persistTimer != null) {
      return;
    }
    _persistTimer = Timer(const Duration(milliseconds: 500), () {
      _persistTimer = null;
      unawaited(_storage.saveTasks(_tasks));
    });
  }

  String _normalizeUrl(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https') || uri.host.isEmpty) {
      throw const FormatException('Only HTTP and HTTPS URLs are supported');
    }
    return uri.toString();
  }

  String _errorMessage(Object error) {
    if (error is DownloadHttpException) {
      return error.toString();
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  String _newId() => '${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}-${math.Random().nextInt(1 << 20)}';

  @override
  void dispose() {
    _persistTimer?.cancel();
    for (final downloader in _active.values) {
      downloader.cancel();
    }
    super.dispose();
  }
}
