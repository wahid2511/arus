import 'dart:async';

import 'package:flutter/services.dart';

/// Polls the desktop clipboard for newly copied download URLs.
///
/// Clipboard access is best-effort: Windows permissions, test hosts, and
/// remote desktop sessions can all make the platform channel unavailable.
/// Those failures are intentionally swallowed so they never affect downloads.
class ClipboardLinkMonitor {
  ClipboardLinkMonitor({this.interval = const Duration(seconds: 2)})
    : _links = StreamController<String>.broadcast();

  final Duration interval;
  final StreamController<String> _links;
  Timer? _timer;
  String? _lastEmitted;
  bool _polling = false;

  Stream<String> get links => _links.stream;

  void start() {
    if (_timer != null) {
      return;
    }
    unawaited(_poll());
    _timer = Timer.periodic(interval, (_) => unawaited(_poll()));
  }

  Future<void> _poll() async {
    if (_polling) {
      return;
    }
    _polling = true;
    try {
      final data = await Clipboard.getData(Clipboard.kTextPlain);
      final value = data?.text?.trim();
      if (value == null ||
          value.isEmpty ||
          value == _lastEmitted ||
          !isDownloadUrl(value)) {
        return;
      }
      _lastEmitted = value;
      if (!_links.isClosed) {
        _links.add(value);
      }
    } catch (_) {
      // Clipboard access is optional and must not interrupt the app loop.
    } finally {
      _polling = false;
    }
  }

  static bool isDownloadUrl(String value) {
    final uri = Uri.tryParse(value);
    return uri != null &&
        const <String>{
          'http',
          'https',
          'ftp',
        }.contains(uri.scheme.toLowerCase()) &&
        uri.host.isNotEmpty;
  }

  void dispose() {
    _timer?.cancel();
    _timer = null;
    unawaited(_links.close());
  }
}
