import 'dart:async';
import 'dart:io';

import 'package:local_notifier/local_notifier.dart';
import 'package:tray_manager/tray_manager.dart';

import '../models/download_models.dart';

class DesktopNotificationService {
  bool _ready = false;

  Future<void> initialize() async {
    try {
      await localNotifier.setup(
        appName: 'Arus',
        shortcutPolicy: ShortcutPolicy.requireNoCreate,
      );
      _ready = true;
    } catch (_) {
      _ready = false;
    }
  }

  Future<void> completed(DownloadTask task) async {
    if (!_ready) {
      return;
    }
    try {
      final notification = LocalNotification(
        title: 'Unduhan selesai',
        body: task.fileName,
      );
      await notification.show();
    } catch (_) {
      // Notifications are optional on locked-down Windows profiles.
    }
  }
}

class ArusTrayController with TrayListener {
  ArusTrayController({required this.onShow, required this.onExit});

  final Future<void> Function() onShow;
  final Future<void> Function() onExit;
  bool _ready = false;

  bool get isReady => _ready;

  Future<void> initialize() async {
    if (!Platform.isWindows && !Platform.isMacOS && !Platform.isLinux) {
      return;
    }
    try {
      trayManager.addListener(this);
      await trayManager.setIcon('windows/runner/resources/app_icon.ico');
      await trayManager.setToolTip('Arus — Download Manager');
      await trayManager.setContextMenu(
        Menu(
          items: <MenuItem>[
            MenuItem(key: 'show_window', label: 'Buka Arus'),
            MenuItem.separator(),
            MenuItem(key: 'exit_app', label: 'Keluar'),
          ],
        ),
      );
      _ready = true;
    } catch (_) {
      trayManager.removeListener(this);
      _ready = false;
    }
  }

  @override
  void onTrayIconMouseDown() {
    unawaited(trayManager.popUpContextMenu());
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    if (menuItem.key == 'show_window') {
      unawaited(onShow());
    } else if (menuItem.key == 'exit_app') {
      unawaited(onExit());
    }
  }

  Future<void> dispose() async {
    if (!_ready) {
      return;
    }
    trayManager.removeListener(this);
    _ready = false;
    try {
      await trayManager.destroy();
    } catch (_) {
      // The tray may already be gone during application shutdown.
    }
  }
}
