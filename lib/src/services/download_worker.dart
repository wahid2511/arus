import '../models/download_models.dart';

/// Common lifecycle contract for protocol-specific download workers.
abstract interface class DownloadWorker {
  Future<void> start();

  void pause();

  void cancel();
}

typedef DownloadProgressCallback = void Function(DownloadProgress progress);
