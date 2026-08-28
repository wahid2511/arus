import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import '../core/path_utils.dart';
import '../models/download_models.dart';
import 'app_storage.dart';
import 'download_worker.dart';
import 'ftp_downloader.dart';
import 'native_host_installer.dart';
import 'rate_limiter.dart';
import 'segmented_downloader.dart';
import 'windows_startup.dart';

class DownloadManager extends ChangeNotifier {
  DownloadManager({AppStorage? storage}) : _storage = storage ?? AppStorage();

  final AppStorage _storage;
  final List<DownloadTask> _tasks = <DownloadTask>[];
  final Map<String, DownloadWorker> _active = <String, DownloadWorker>{};
  final Map<String, Future<void>> _runs = <String, Future<void>>{};
  final Set<String> _starting = <String>{};
  final StreamController<DownloadTask> _completed =
      StreamController<DownloadTask>.broadcast();
  final DownloadRateLimiter _rateLimiter = DownloadRateLimiter();
  final WindowsStartupService _startup = const WindowsStartupService();
  DownloadSettings _settings = const DownloadSettings();
  Timer? _persistTimer;
  Future<void> _persistChain = Future<void>.value();
  bool _ready = false;
  bool _disposed = false;

  bool get ready => _ready;
  DownloadSettings get settings => _settings;
  List<DownloadTask> get tasks => List<DownloadTask>.unmodifiable(_tasks);
  Stream<DownloadTask> get completed => _completed.stream;
  String get defaultDirectory => defaultDownloadDirectory();

  Future<void> init() async {
    await _storage.prepare();
    _settings = await _storage.loadSettings();
    _rateLimiter.limitBytesPerSecond = _settings.speedLimitBytesPerSecond;
    _tasks
      ..clear()
      ..addAll(await _storage.loadTasks());
    var pathsChanged = false;
    for (final task in _tasks) {
      if (task.status == DownloadStatus.downloading ||
          task.status == DownloadStatus.queued) {
        task.status = DownloadStatus.paused;
        task.speedBytesPerSecond = 0;
      }
      if (task.status != DownloadStatus.completed) {
        pathsChanged = await _repairTaskPathAndFiles(task) || pathsChanged;
      }
      if (task.status == DownloadStatus.completed) {
        // A previous process may have finished the rename but been unable to
        // remove a checkpoint. Completed tasks must never keep stale .part
        // or .part.meta.json files around.
        await _deletePartFiles(task);
        task.segments = null;
      }
      task.segments = task.segments
          ?.map((segment) => segment..active = false)
          .toList();
    }
    if (pathsChanged) {
      await _persistNow();
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

    final preferredName = safeFileNameForDirectory(
      fileName?.trim().isNotEmpty == true
          ? fileName!.trim()
          : nameFromUrl(normalizedUrl),
      targetDirectory,
    );
    final reserved = _tasks.map((task) => task.filePath);
    final path = uniqueFilePath(
      targetDirectory,
      preferredName,
      reserved: reserved,
    );
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
    await _repairTaskPathAndFiles(task);
    task.error = null;
    task.speedBytesPerSecond = 0;
    task.status = DownloadStatus.queued;
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> cancel(String id) async {
    final task = _task(id);
    final active = _active[id];
    active?.cancel();
    task.status = DownloadStatus.cancelled;
    task.speedBytesPerSecond = 0;
    // The worker owns the open file handles. Deleting .part immediately is a
    // race on Windows; _start performs cleanup after the worker exits.
    if (active == null && !_runs.containsKey(id)) {
      await _deletePartFiles(task);
    }
    await _persistNow();
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> remove(String id) async {
    final task = _task(id);
    final run = _runs[id];
    if (task.status == DownloadStatus.downloading ||
        task.status == DownloadStatus.queued) {
      await cancel(id);
    }
    if (run != null) {
      if (task.status != DownloadStatus.cancelled) {
        _active[id]?.cancel();
        task.status = DownloadStatus.cancelled;
      }
      await run;
    } else {
      await _deletePartFiles(task);
    }
    // Removing history only deletes resumable temporary files and metadata.
    // Keep the final downloaded file and all build artifacts untouched.
    _tasks.removeWhere((item) => item.id == id);
    await _persistNow();
    notifyListeners();
  }

  Future<void> pauseAll() async {
    final ids = _tasks
        .where(
          (task) =>
              task.status == DownloadStatus.downloading ||
              task.status == DownloadStatus.queued,
        )
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
    final ids = _tasks
        .where((task) => task.status == DownloadStatus.completed)
        .map((task) => task.id)
        .toList();
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

  Future<void> installNativeHost() => const NativeHostInstaller().install();

  Future<void> updateSettings({
    int? connections,
    int? maxConcurrentDownloads,
    int? minSegmentSizeBytes,
    int? maxSegmentRetries,
    int? speedLimitBytesPerSecond,
    bool? revealOnComplete,
    bool? browserIntegrationEnabled,
    bool? launchAtLogin,
    bool? minimizeToTray,
  }) async {
    _settings = _settings.copyWith(
      connections: connections?.clamp(4, 16).toInt(),
      maxConcurrentDownloads: maxConcurrentDownloads?.clamp(1, 10).toInt(),
      minSegmentSizeBytes: minSegmentSizeBytes
          ?.clamp(64 * 1024, 8 * 1024 * 1024)
          .toInt(),
      maxSegmentRetries: maxSegmentRetries?.clamp(0, 10).toInt(),
      speedLimitBytesPerSecond: speedLimitBytesPerSecond
          ?.clamp(0, 1024 * 1024 * 1024)
          .toInt(),
      revealOnComplete: revealOnComplete,
      browserIntegrationEnabled: browserIntegrationEnabled,
      launchAtLogin: launchAtLogin,
      minimizeToTray: minimizeToTray,
    );
    _rateLimiter.limitBytesPerSecond = _settings.speedLimitBytesPerSecond;
    if (launchAtLogin != null) {
      await _startup.setEnabled(_settings.launchAtLogin);
    }
    await _storage.saveSettings(_settings);
    notifyListeners();
    unawaited(_pump());
  }

  Future<void> _pump() async {
    if (!_ready || _disposed) {
      return;
    }
    final freeSlots =
        _settings.maxConcurrentDownloads - _active.length - _starting.length;
    if (freeSlots <= 0) {
      return;
    }
    final queued = _tasks
        .where((task) => task.status == DownloadStatus.queued)
        .take(freeSlots)
        .toList();
    for (final task in queued) {
      final run = _start(task);
      _runs[task.id] = run;
      unawaited(run);
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
      final worker = _createWorker(task);
      _active[task.id] = worker;
      await worker.start();
      if (task.status != DownloadStatus.downloading) {
        return;
      }
      task.status = DownloadStatus.completed;
      task.progress = 100;
      task.bytesReceived = task.totalBytes ?? task.bytesReceived;
      task.speedBytesPerSecond = 0;
      task.segments = null;
      await _deletePartFiles(task);
      if (!_completed.isClosed) {
        _completed.add(task.snapshot());
      }
      if (_settings.revealOnComplete) {
        try {
          await revealInFolder(task.id);
        } catch (_) {
          // Revealing the file is a convenience and must not turn a completed
          // download into a failed task.
        }
      }
    } on DownloadAbortException catch (error) {
      if (error.reason == 'paused' || task.status == DownloadStatus.paused) {
        task.status = DownloadStatus.paused;
      } else if (task.status != DownloadStatus.cancelled) {
        task.status = DownloadStatus.cancelled;
      }
      task.speedBytesPerSecond = 0;
    } catch (error) {
      if (task.status != DownloadStatus.paused &&
          task.status != DownloadStatus.cancelled) {
        task.status = DownloadStatus.failed;
        task.error = _errorMessage(error);
        task.speedBytesPerSecond = 0;
      }
    } finally {
      if (task.status == DownloadStatus.cancelled) {
        await _deletePartFiles(task);
      }
      _active.remove(task.id);
      _starting.remove(task.id);
      _runs.remove(task.id);
      await _persistNow();
      if (!_disposed) {
        notifyListeners();
      }
      unawaited(_pump());
    }
  }

  DownloadWorker _createWorker(DownloadTask task) {
    final scheme = Uri.tryParse(task.url)?.scheme.toLowerCase();
    if (scheme == 'ftp') {
      return FtpDownloader(
        id: task.id,
        url: task.url,
        filePath: task.filePath,
        tempPath: task.tempPath,
        metaPath: task.metaPath,
        maxRetries: _settings.maxSegmentRetries,
        onProgress: (progress) => _handleProgress(task, progress),
        rateLimiter: _rateLimiter,
      );
    }
    if (scheme == 'http' || scheme == 'https') {
      return SegmentedDownloader(
        id: task.id,
        url: task.url,
        filePath: task.filePath,
        tempPath: task.tempPath,
        metaPath: task.metaPath,
        connections: _settings.connections,
        minSegmentSizeBytes: _settings.minSegmentSizeBytes,
        maxRetries: _settings.maxSegmentRetries,
        requestHeaders: task.headers,
        rateLimiter: _rateLimiter,
        onProgress: (progress) => _handleProgress(task, progress),
        onFileName: (fileName) => _adoptSuggestedFileName(task, fileName),
      );
    }
    throw FormatException(
      'Unsupported download protocol: ${scheme ?? 'unknown'}',
    );
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

  Future<void> _adoptSuggestedFileName(
    DownloadTask task,
    String suggestedName,
  ) async {
    if (_disposed || task.status != DownloadStatus.downloading) {
      return;
    }
    final currentName = task.fileName.trim();
    if (!isLikelyOpaqueUrlFileName(currentName) &&
        currentName != 'download.bin') {
      return;
    }
    final candidate = safeFileNameForDirectory(suggestedName, task.directory);
    if (candidate.isEmpty || candidate == currentName) {
      return;
    }
    final oldTempPath = task.tempPath;
    final oldMetaPath = task.metaPath;
    final reserved = _tasks
        .where((other) => other.id != task.id)
        .map((other) => other.filePath);
    final nextPath = uniqueFilePath(
      task.directory,
      candidate,
      reserved: reserved,
    );
    task.filePath = nextPath;
    task.fileName = baseName(nextPath);
    await _relocateIfNeeded(oldTempPath, task.tempPath);
    await _relocateIfNeeded(oldMetaPath, task.metaPath);
    await _relocateIfNeeded('$oldMetaPath.tmp', '${task.metaPath}.tmp');
    await _persistNow();
    notifyListeners();
  }

  bool _repairTaskPath(DownloadTask task) {
    final directory = task.directory.trim();
    if (directory.isEmpty) {
      return false;
    }

    final currentName = task.fileName.trim();
    final sourceName = currentName.isEmpty
        ? baseName(task.filePath)
        : isLikelyOpaqueUrlFileName(currentName)
        ? nameFromUrl(task.url)
        : currentName;
    final safeName = safeFileNameForDirectory(sourceName, directory);
    final expectedPath = joinPath(directory, safeName);
    if (task.filePath == expectedPath && task.fileName == safeName) {
      return false;
    }

    final reserved = _tasks
        .where((candidate) => candidate.id != task.id)
        .map((candidate) => candidate.filePath);
    final repairedPath = uniqueFilePath(
      directory,
      safeName,
      reserved: reserved,
    );
    final changed =
        task.filePath != repairedPath ||
        task.fileName != baseName(repairedPath);
    if (changed) {
      task.filePath = repairedPath;
      task.fileName = baseName(repairedPath);
    }
    return changed;
  }

  Future<bool> _repairTaskPathAndFiles(DownloadTask task) async {
    final oldTempPath = task.tempPath;
    final oldMetaPath = task.metaPath;
    final changed = _repairTaskPath(task);
    if (!changed) {
      return false;
    }
    await _relocateIfNeeded(oldTempPath, task.tempPath);
    await _relocateIfNeeded(oldMetaPath, task.metaPath);
    await _relocateIfNeeded('$oldMetaPath.tmp', '${task.metaPath}.tmp');
    return true;
  }

  Future<void> _relocateIfNeeded(String sourcePath, String targetPath) async {
    if (sourcePath == targetPath) {
      return;
    }
    final source = File(sourcePath);
    if (!await source.exists() || await File(targetPath).exists()) {
      return;
    }
    try {
      await Directory(parentPath(targetPath)).create(recursive: true);
      await source.rename(targetPath);
    } catch (_) {
      // A stale checkpoint should never prevent the task from loading. The
      // next retry can start cleanly if the old path cannot be moved.
    }
  }

  DownloadTask _task(String id) {
    return _tasks.firstWhere(
      (task) => task.id == id,
      orElse: () => throw StateError('Download task not found'),
    );
  }

  Future<void> _deletePartFiles(DownloadTask task) async {
    for (final path in <String>[
      task.tempPath,
      task.metaPath,
      '${task.metaPath}.tmp',
    ]) {
      final file = File(path);
      for (var attempt = 0; attempt < 5; attempt += 1) {
        if (!await file.exists()) {
          break;
        }
        try {
          await file.delete();
          if (!await file.exists()) {
            break;
          }
        } catch (_) {
          // Windows can briefly keep a just-closed checkpoint locked.
        }
        await Future<void>.delayed(Duration(milliseconds: 25 * (attempt + 1)));
      }
    }
  }

  Future<void> _persistNow() async {
    _persistTimer?.cancel();
    _persistTimer = null;
    final next = _persistChain.then<void>((_) async {
      await _storage.saveTasks(_tasks.map((task) => task.snapshot()));
    });
    _persistChain = next.then<void>((_) {}, onError: (_) {});
    await next;
  }

  void _schedulePersist() {
    if (_persistTimer != null) {
      return;
    }
    _persistTimer = Timer(const Duration(milliseconds: 500), () {
      _persistTimer = null;
      unawaited(_persistNow());
    });
  }

  String _normalizeUrl(String raw) {
    final uri = Uri.tryParse(raw.trim());
    if (uri != null &&
        const <String>{
          'magnet',
          'torrent',
        }.contains(uri.scheme.toLowerCase())) {
      throw UnsupportedError(
        'Torrent downloads require the optional native libtorrent provider',
      );
    }
    if (uri == null ||
        !const <String>{
          'http',
          'https',
          'ftp',
        }.contains(uri.scheme.toLowerCase()) ||
        uri.host.isEmpty) {
      throw const FormatException(
        'Only HTTP, HTTPS, and FTP URLs are supported',
      );
    }
    return uri.toString();
  }

  String _errorMessage(Object error) {
    if (error is DownloadHttpException) {
      return error.toString();
    }
    return error.toString().replaceFirst('Exception: ', '');
  }

  String _newId() =>
      '${DateTime.now().microsecondsSinceEpoch.toRadixString(16)}-${math.Random().nextInt(1 << 20)}';

  @override
  void dispose() {
    _disposed = true;
    _persistTimer?.cancel();
    for (final worker in _active.values) {
      worker.cancel();
    }
    unawaited(_completed.close());
    super.dispose();
  }
}
