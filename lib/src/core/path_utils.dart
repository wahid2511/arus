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

String safeFileName(String value, [String fallback = 'download.bin']) {
  final lastPart = baseName(value).trim();
  final safe = lastPart
      .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1F]'), '_')
      .replaceAll(RegExp(r'[. ]+$'), '')
      .trim();
  return safe.isEmpty ? fallback : safe;
}

String nameFromUrl(String url, [String fallback = 'download.bin']) {
  try {
    final uri = Uri.parse(url);
    if (uri.pathSegments.isEmpty) {
      return fallback;
    }
    return Uri.decodeComponent(uri.pathSegments.last);
  } catch (_) {
    return fallback;
  }
}

String uniqueFilePath(String directory, String preferredName, {Iterable<String> reserved = const <String>[]}) {
  final reservedPaths = reserved.map(_normalizeForComparison).toSet();
  var candidate = joinPath(directory, preferredName);
  if (!_pathExists(candidate, reservedPaths)) {
    return candidate;
  }

  final name = baseName(preferredName);
  final dot = name.lastIndexOf('.');
  final stem = dot > 0 ? name.substring(0, dot) : name;
  final extension = dot > 0 ? name.substring(dot) : '';
  var index = 1;
  while (true) {
    candidate = joinPath(directory, '$stem ($index)$extension');
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
    final base = environment['APPDATA'] ?? environment['LOCALAPPDATA'] ?? _homeDirectory();
    return joinPath(base ?? Directory.current.path, 'Arus');
  }
  if (Platform.isMacOS) {
    return joinPath(_homeDirectory() ?? Directory.current.path, 'Library/Application Support/Arus');
  }
  final base = environment['XDG_CONFIG_HOME'] ?? joinPath(_homeDirectory() ?? Directory.current.path, '.config');
  return joinPath(base, 'arus');
}

String? _homeDirectory() {
  final environment = Platform.environment;
  if (Platform.isWindows) {
    final profile = environment['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) {
      return profile;
    }
    final home = '${environment['HOMEDRIVE'] ?? ''}${environment['HOMEPATH'] ?? ''}';
    return home.trim().isEmpty ? null : home;
  }
  return environment['HOME'];
}

String formatBytes(int bytes) {
  if (bytes < 1024) {
    return '$bytes B';
  }
  const units = <String>['KB', 'MB', 'GB', 'TB'];
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
