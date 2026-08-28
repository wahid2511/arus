enum DownloadStatus {
  queued,
  downloading,
  paused,
  completed,
  failed,
  cancelled,
}

extension DownloadStatusLabel on DownloadStatus {
  String get label {
    switch (this) {
      case DownloadStatus.queued:
        return 'Antrean';
      case DownloadStatus.downloading:
        return 'Mengunduh';
      case DownloadStatus.paused:
        return 'Dijeda';
      case DownloadStatus.completed:
        return 'Selesai';
      case DownloadStatus.failed:
        return 'Gagal';
      case DownloadStatus.cancelled:
        return 'Sampah';
    }
  }
}

class DownloadSegment {
  DownloadSegment({
    required this.index,
    required this.start,
    required this.end,
    this.downloaded = 0,
    this.active = false,
  });

  factory DownloadSegment.fromJson(Map<String, dynamic> json) {
    return DownloadSegment(
      index: _intValue(json['index']),
      start: _intValue(json['start']),
      end: _intValue(json['end']),
      downloaded: _intValue(json['downloaded']),
      active: false,
    );
  }

  final int index;
  final int start;
  int end;
  int downloaded;
  bool active;

  int get length => end - start + 1;
  int get remaining => (length - downloaded).clamp(0, length);
  double get progress =>
      length <= 0 ? 0 : (downloaded / length).clamp(0, 1).toDouble();

  Map<String, dynamic> toJson() => <String, dynamic>{
    'index': index,
    'start': start,
    'end': end,
    'downloaded': downloaded,
  };

  DownloadSegment copy() => DownloadSegment(
    index: index,
    start: start,
    end: end,
    downloaded: downloaded,
    active: active,
  );
}

class DownloadTask {
  DownloadTask({
    required this.id,
    required this.url,
    required this.fileName,
    required this.filePath,
    required this.directory,
    required this.createdAt,
    this.status = DownloadStatus.queued,
    this.progress = 0,
    this.bytesReceived = 0,
    this.totalBytes,
    this.speedBytesPerSecond = 0,
    this.error,
    this.segments,
    this.headers,
  }) : updatedAt = createdAt;

  factory DownloadTask.fromJson(Map<String, dynamic> json) {
    final createdAt = DateTime.fromMillisecondsSinceEpoch(
      _intValue(json['createdAt'], DateTime.now().millisecondsSinceEpoch),
    );
    final rawStatus = json['status']?.toString();
    final status = DownloadStatus.values.firstWhere(
      (value) => value.name == rawStatus,
      orElse: () => DownloadStatus.paused,
    );
    final rawSegments = json['segments'];
    final rawHeaders = json['headers'] ?? json['requestHeaders'];
    return DownloadTask(
      id: json['id']?.toString() ?? _newId(),
      url: json['url']?.toString() ?? '',
      fileName: json['fileName']?.toString() ?? 'download.bin',
      filePath: json['filePath']?.toString() ?? '',
      directory: json['directory']?.toString() ?? '',
      createdAt: createdAt,
      status: status,
      progress: _doubleValue(json['progress']),
      bytesReceived: _intValue(json['bytesReceived']),
      totalBytes: json['totalBytes'] is num
          ? (json['totalBytes'] as num).toInt()
          : null,
      speedBytesPerSecond: _intValue(json['speedBytesPerSecond']),
      error: json['error']?.toString(),
      segments: rawSegments is List
          ? rawSegments
                .whereType<Map>()
                .map(
                  (item) =>
                      DownloadSegment.fromJson(Map<String, dynamic>.from(item)),
                )
                .toList()
          : null,
      headers: rawHeaders is Map
          ? Map<String, String>.from(
              rawHeaders.map(
                (key, value) => MapEntry(key.toString(), value.toString()),
              ),
            )
          : null,
    );
  }

  final String id;
  final String url;
  String fileName;
  String filePath;
  String directory;
  DownloadStatus status;
  double progress;
  int bytesReceived;
  int? totalBytes;
  int speedBytesPerSecond;
  DateTime createdAt;
  DateTime updatedAt;
  String? error;
  List<DownloadSegment>? segments;
  Map<String, String>? headers;

  String get tempPath => '$filePath.part';
  String get metaPath => '$filePath.part.meta.json';

  Map<String, dynamic> toJson({bool includeHeaders = true}) =>
      <String, dynamic>{
        'id': id,
        'url': url,
        'fileName': fileName,
        'filePath': filePath,
        'directory': directory,
        'status': status.name,
        'progress': progress,
        'bytesReceived': bytesReceived,
        'totalBytes': totalBytes,
        'speedBytesPerSecond': speedBytesPerSecond,
        'createdAt': createdAt.millisecondsSinceEpoch,
        'updatedAt': updatedAt.millisecondsSinceEpoch,
        if (error != null) 'error': error,
        if (segments != null)
          'segments': segments!.map((segment) => segment.toJson()).toList(),
        if (includeHeaders && headers != null) 'headers': headers,
      };

  DownloadTask snapshot() {
    return DownloadTask(
      id: id,
      url: url,
      fileName: fileName,
      filePath: filePath,
      directory: directory,
      createdAt: createdAt,
      status: status,
      progress: progress,
      bytesReceived: bytesReceived,
      totalBytes: totalBytes,
      speedBytesPerSecond: speedBytesPerSecond,
      error: error,
      segments: segments?.map((segment) => segment.copy()).toList(),
      headers: headers == null ? null : <String, String>{...headers!},
    )..updatedAt = updatedAt;
  }
}

class DownloadSettings {
  const DownloadSettings({
    this.connections = 8,
    this.maxConcurrentDownloads = 3,
    this.minSegmentSizeBytes = 512 * 1024,
    this.maxSegmentRetries = 3,
    this.speedLimitBytesPerSecond = 0,
    this.revealOnComplete = true,
    this.browserIntegrationEnabled = true,
    this.launchAtLogin = true,
    this.minimizeToTray = true,
  });

  factory DownloadSettings.fromJson(Map<String, dynamic> json) {
    return DownloadSettings(
      connections: _clampInt(json['connections'], 4, 16, 8),
      maxConcurrentDownloads: _clampInt(
        json['maxConcurrentDownloads'],
        1,
        10,
        3,
      ),
      minSegmentSizeBytes: _clampInt(
        json['minSegmentSizeBytes'],
        64 * 1024,
        8 * 1024 * 1024,
        512 * 1024,
      ),
      maxSegmentRetries: _clampInt(json['maxSegmentRetries'], 0, 10, 3),
      speedLimitBytesPerSecond: _clampInt(
        json['speedLimitBytesPerSecond'],
        0,
        1024 * 1024 * 1024,
        0,
      ),
      revealOnComplete: json['revealOnComplete'] is bool
          ? json['revealOnComplete'] as bool
          : true,
      browserIntegrationEnabled: json['browserIntegrationEnabled'] is bool
          ? json['browserIntegrationEnabled'] as bool
          : true,
      launchAtLogin: json['launchAtLogin'] is bool
          ? json['launchAtLogin'] as bool
          : true,
      minimizeToTray: json['minimizeToTray'] is bool
          ? json['minimizeToTray'] as bool
          : true,
    );
  }

  final int connections;
  final int maxConcurrentDownloads;
  final int minSegmentSizeBytes;
  final int maxSegmentRetries;

  /// Zero means unlimited. The value applies to all active downloads.
  final int speedLimitBytesPerSecond;
  final bool revealOnComplete;
  final bool browserIntegrationEnabled;
  final bool launchAtLogin;
  final bool minimizeToTray;

  DownloadSettings copyWith({
    int? connections,
    int? maxConcurrentDownloads,
    int? minSegmentSizeBytes,
    int? maxSegmentRetries,
    int? speedLimitBytesPerSecond,
    bool? revealOnComplete,
    bool? browserIntegrationEnabled,
    bool? launchAtLogin,
    bool? minimizeToTray,
  }) {
    return DownloadSettings(
      connections: connections ?? this.connections,
      maxConcurrentDownloads:
          maxConcurrentDownloads ?? this.maxConcurrentDownloads,
      minSegmentSizeBytes: minSegmentSizeBytes ?? this.minSegmentSizeBytes,
      maxSegmentRetries: maxSegmentRetries ?? this.maxSegmentRetries,
      speedLimitBytesPerSecond:
          speedLimitBytesPerSecond ?? this.speedLimitBytesPerSecond,
      revealOnComplete: revealOnComplete ?? this.revealOnComplete,
      browserIntegrationEnabled:
          browserIntegrationEnabled ?? this.browserIntegrationEnabled,
      launchAtLogin: launchAtLogin ?? this.launchAtLogin,
      minimizeToTray: minimizeToTray ?? this.minimizeToTray,
    );
  }

  Map<String, dynamic> toJson() => <String, dynamic>{
    'connections': connections,
    'maxConcurrentDownloads': maxConcurrentDownloads,
    'minSegmentSizeBytes': minSegmentSizeBytes,
    'maxSegmentRetries': maxSegmentRetries,
    'speedLimitBytesPerSecond': speedLimitBytesPerSecond,
    'revealOnComplete': revealOnComplete,
    'browserIntegrationEnabled': browserIntegrationEnabled,
    'launchAtLogin': launchAtLogin,
    'minimizeToTray': minimizeToTray,
  };
}

class DownloadProgress {
  const DownloadProgress({
    required this.id,
    required this.downloadedBytes,
    required this.totalBytes,
    required this.speedBytesPerSecond,
    required this.percent,
    this.segments,
  });

  final String id;
  final int downloadedBytes;
  final int? totalBytes;
  final int speedBytesPerSecond;
  final double percent;
  final List<DownloadSegment>? segments;
}

int _intValue(Object? value, [int fallback = 0]) {
  return value is num
      ? value.toInt()
      : int.tryParse(value?.toString() ?? '') ?? fallback;
}

double _doubleValue(Object? value, [double fallback = 0]) {
  return value is num
      ? value.toDouble()
      : double.tryParse(value?.toString() ?? '') ?? fallback;
}

int _clampInt(Object? value, int min, int max, int fallback) {
  return _intValue(value, fallback).clamp(min, max).toInt();
}

String _newId() => DateTime.now().microsecondsSinceEpoch.toRadixString(16);
