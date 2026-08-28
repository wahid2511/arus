import 'dart:io';
import 'dart:math' as math;

String joinPath(String first, [String? second, String? third]) {
  var result = first;
  for (final part in <String?>[second, third]) {
    if (part == null || part.isEmpty) {
      continue;
    }
    if (result.isEmpty) {
      result = part;
    } else if (result.endsWith('/') || result.endsWith(r'\')) {
      result += part;
    } else {
      result += '${Platform.pathSeparator}$part';
    }
  }
  return result;
}

String parentPath(String path) {
  final slash = math.max(path.lastIndexOf('/'), path.lastIndexOf(r'\'));
  if (slash < 0) {
    return '.';
  }
  if (slash == 0) {
    return path.substring(0, 1);
  }
  if (slash == 2 && path.length >= 3 && path[1] == ':') {
    return path.substring(0, 3);
  }
  return path.substring(0, slash);
}

String baseName(String path) {
  final slash = math.max(path.lastIndexOf('/'), path.lastIndexOf(r'\'));
  return slash < 0 ? path : path.substring(slash + 1);
}

const int _defaultSafeFileNameLength = 120;
const int _conservativeWindowsPathLength = 240;
const String _downloadMetadataSuffix = '.part.meta.json';
const Set<String> _reservedWindowsNames = <String>{
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
};

String safeFileName(String value, [String fallback = 'download.bin']) {
  return _sanitizeFileName(value, fallback, _defaultSafeFileNameLength);
}

String safeFileNameForDirectory(
  String value,
  String directory, [
  String fallback = 'download.bin',
]) {
  return _sanitizeFileName(value, fallback, maxSafeFileNameLength(directory));
}

int maxSafeFileNameLength(String directory) {
  if (!Platform.isWindows) {
    return 180;
  }
  final available =
      _conservativeWindowsPathLength -
      directory.length -
      Platform.pathSeparator.length -
      _downloadMetadataSuffix.length;
  return available.clamp(16, _defaultSafeFileNameLength).toInt();
}

String _sanitizeFileName(String value, String fallback, int maxLength) {
  String sanitize(String input) {
    return input
        .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1F]'), '_')
        .replaceAll(RegExp(r'[. ]+$'), '')
        .trim();
  }

  var safe = sanitize(baseName(value).trim());
  if (safe.isEmpty) {
    safe = sanitize(fallback);
  }
  if (safe.isEmpty) {
    safe = 'download.bin';
  }

  final dot = safe.indexOf('.');
  final stem = (dot > 0 ? safe.substring(0, dot) : safe).toUpperCase();
  if (_reservedWindowsNames.contains(stem)) {
    safe = '_$safe';
  }

  return _truncateFileName(
    _trimTrailingNameCharacters(safe),
    math.max(1, maxLength),
  );
}

String _truncateFileName(String value, int maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  final dot = value.lastIndexOf('.');
  final extensionLength = value.length - dot;
  if (dot > 0 && dot < value.length - 1 && extensionLength < maxLength) {
    final extension = value.substring(dot);
    final stemLength = maxLength - extension.length;
    final stem = _trimTrailingNameCharacters(value.substring(0, stemLength));
    return (stem.isEmpty ? 'download' : stem) + extension;
  }

  final prefix = _trimTrailingNameCharacters(value.substring(0, maxLength));
  return prefix.isEmpty ? 'download' : prefix;
}

String _trimTrailingNameCharacters(String value) {
  return value.replaceAll(RegExp(r'[. ]+$'), '').trim();
}

String nameFromUrl(String url, [String fallback = 'download.bin']) {
  try {
    final uri = Uri.parse(url);
    for (final key in const <String>['filename', 'file', 'name']) {
      final queryName = uri.queryParameters[key]?.trim();
      if (queryName != null && queryName.isNotEmpty) {
        return queryName;
      }
    }
    if (uri.pathSegments.isEmpty) {
      return fallback;
    }
    final candidate = Uri.decodeComponent(uri.pathSegments.last).trim();
    return isLikelyOpaqueUrlFileName(candidate) ? fallback : candidate;
  } catch (_) {
    return fallback;
  }
}

/// Returns true for opaque IDs commonly used by temporary download proxies.
/// They are technically valid path segments, but make poor user-facing file
/// names and can be hundreds of characters long.
bool isLikelyOpaqueUrlFileName(String value) {
  final name = baseName(value).trim();
  if (name.length < 48 || !RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(name)) {
    return false;
  }
  final dot = name.lastIndexOf('.');
  final extensionLength = dot >= 0 ? name.length - dot - 1 : 0;
  return dot < 0 || extensionLength > 8;
}

/// Extracts the filename from an HTTP Content-Disposition header.
/// Supports both the modern RFC 5987 `filename*` form and the older
/// `filename` form.
String? fileNameFromContentDisposition(String? header) {
  if (header == null || header.trim().isEmpty) {
    return null;
  }
  final encoded = RegExp(
    r'''(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)''',
    caseSensitive: false,
  ).firstMatch(header);
  final plain = RegExp(
    r'''(?:^|;)\s*filename\s*=\s*("[^"]*"|[^;]+)''',
    caseSensitive: false,
  ).firstMatch(header);
  var value = (encoded?.group(1) ?? plain?.group(1))?.trim();
  if (value == null || value.isEmpty) {
    return null;
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.substring(1, value.length - 1);
  }
  value = value.replaceAll(r'\"', '"').trim();
  if (encoded != null) {
    try {
      value = Uri.decodeComponent(value);
    } catch (_) {
      // Keep the original value if a malformed proxy header is encountered.
    }
  }
  return value!.isEmpty ? null : value;
}

String uniqueFilePath(
  String directory,
  String preferredName, {
  Iterable<String> reserved = const <String>[],
}) {
  final reservedPaths = reserved.map(_normalizeForComparison).toSet();
  final boundedName = safeFileNameForDirectory(preferredName, directory);
  final maxLength = maxSafeFileNameLength(directory);
  var candidate = joinPath(directory, boundedName);
  if (!_pathExists(candidate, reservedPaths)) {
    return candidate;
  }

  final name = baseName(boundedName);
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final extension = dot > 0 ? name.substring(dot) : '';
  var index = 1;
  while (true) {
    final suffix = ' ($index)$extension';
    final stemLength = math.max(1, maxLength - suffix.length);
    final boundedStem = stem.length > stemLength
        ? stem.substring(0, stemLength)
        : stem;
    candidate = joinPath(
      directory,
      _trimTrailingNameCharacters('$boundedStem$suffix'),
    );
    if (!_pathExists(candidate, reservedPaths)) {
      return candidate;
    }
    index += 1;
  }
}

bool _pathExists(String path, Set<String> reserved) {
  final normalized = _normalizeForComparison(path);
  return reserved.contains(normalized) ||
      File(path).existsSync() ||
      File('$path.part').existsSync();
}

String _normalizeForComparison(String path) {
  final normalized = path.replaceAll('/', r'\');
  return Platform.isWindows ? normalized.toLowerCase() : normalized;
}

String defaultDownloadDirectory() {
  final home = _homeDirectory();
  return home == null ? Directory.current.path : joinPath(home, 'Downloads');
}

String appDataDirectory() {
  final environment = Platform.environment;
  if (Platform.isWindows) {
    final base =
        environment['APPDATA'] ??
        environment['LOCALAPPDATA'] ??
        _homeDirectory();
    return joinPath(base ?? Directory.current.path, 'Arus');
  }
  if (Platform.isMacOS) {
    return joinPath(
      _homeDirectory() ?? Directory.current.path,
      'Library/Application Support/Arus',
    );
  }
  final base =
      environment['XDG_CONFIG_HOME'] ??
      joinPath(_homeDirectory() ?? Directory.current.path, '.config');
  return joinPath(base, 'arus');
}

String? _homeDirectory() {
  final environment = Platform.environment;
  if (Platform.isWindows) {
    final profile = environment['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) {
      return profile;
    }
    final home =
        '${environment['HOMEDRIVE'] ?? ''}${environment['HOMEPATH'] ?? ''}';
    return home.trim().isEmpty ? null : home;
  }
  return environment['HOME'];
}

String formatBytes(int bytes) {
  const units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
  var value = bytes.toDouble();
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return '${value.toStringAsFixed(value >= 10 ? 0 : 1)} ${units[unit]}';
}

String formatSpeed(int bytesPerSecond) => '${formatBytes(bytesPerSecond)}/s';

String formatEta(int remainingBytes, int bytesPerSecond) {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) {
    return '—';
  }
  final seconds = (remainingBytes / bytesPerSecond).ceil();
  if (seconds >= 3600) {
    return '${seconds ~/ 3600}j ${(seconds % 3600) ~/ 60}m';
  }
  if (seconds >= 60) {
    return '${seconds ~/ 60}m ${seconds % 60}d';
  }
  return '${seconds}d';
}
