import 'dart:async';
import 'dart:math' as math;

/// A byte-rate limiter shared by all active downloads.
///
/// Reservations happen synchronously before the first await, so concurrent
/// segment workers cannot bypass the limit. Waits are sliced into short
/// intervals so pausing a download remains responsive even at low rates.
class DownloadRateLimiter {
  DownloadRateLimiter({this.limitBytesPerSecond = 0})
    : _clock = Stopwatch()..start();

  static const int unlimited = 0;
  static const int maxChunkBytes = 64 * 1024;
  static const int _maxWaitSliceMicros = 250 * 1000;

  final Stopwatch _clock;
  int limitBytesPerSecond;
  int _nextAvailableMicros = 0;

  bool get isLimited => limitBytesPerSecond > unlimited;

  int get suggestedChunkBytes {
    final limit = limitBytesPerSecond;
    if (limit <= unlimited) {
      return maxChunkBytes;
    }
    return math.max(1, math.min(maxChunkBytes, limit ~/ 4));
  }

  Future<void> throttle(int bytes, {bool Function()? isCancelled}) async {
    final limit = limitBytesPerSecond;
    if (bytes <= 0 || limit <= unlimited) {
      return;
    }

    final now = _clock.elapsedMicroseconds;
    final start = math.max(now, _nextAvailableMicros);
    final duration = (bytes * Duration.microsecondsPerSecond / limit).ceil();
    _nextAvailableMicros = start + math.max(1, duration);

    var remaining = start - now;
    while (remaining > 0) {
      if (isCancelled?.call() ?? false) {
        return;
      }
      final slice = math.min(remaining, _maxWaitSliceMicros);
      await Future<void>.delayed(Duration(microseconds: slice));
      remaining -= slice;
    }
  }

  void reset() {
    _nextAvailableMicros = _clock.elapsedMicroseconds;
  }
}
