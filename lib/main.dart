import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'src/core/path_utils.dart';
import 'src/models/download_models.dart';
import 'src/services/app_storage.dart';
import 'src/services/clipboard_link_monitor.dart';
import 'src/services/desktop_integrations.dart';
import 'src/services/download_manager.dart';
import 'src/services/native_messaging.dart';
import 'src/services/windows_startup.dart';
import 'package:window_manager/window_manager.dart';

const _background = Color(0xFF12181F);
const _panel = Color(0xFF1E2630);
const _border = Color(0xFF2A3541);
const _primary = Color(0xFFF0A63F);
const _secondary = Color(0xFF2DD4BF);
const _activeBlue = Color(0xFF3188E8);
const _success = Color(0xFF6FCF8E);
const _error = Color(0xFFE2574C);
const _text = Color(0xFFE9EEF5);
const _muted = Color(0xFF91A0B2);

Future<void> main([List<String> args = const <String>[]]) async {
  WidgetsFlutterBinding.ensureInitialized();
  if (args.contains('--native-host')) {
    await runNativeMessagingHost();
    // The Windows runner owns a message loop outside the Dart isolate. Exit
    // explicitly after the browser closes stdin so a one-shot native host
    // cannot leave a hidden Flutter process behind.
    exit(0);
  }
  try {
    await windowManager.ensureInitialized();
    await windowManager.waitUntilReadyToShow(
      const WindowOptions(
        size: Size(1280, 720),
        minimumSize: Size(800, 520),
        center: true,
        skipTaskbar: false,
        title: 'Arus',
      ),
      () async {
        await windowManager.show();
        await windowManager.focus();
      },
    );
  } catch (_) {
    // Desktop window control is optional in tests and unsupported targets.
  }
  final notifications = DesktopNotificationService();
  await notifications.initialize();
  final manager = DownloadManager(storage: AppStorage());
  await manager.init();
  try {
    await const WindowsStartupService().setEnabled(
      manager.settings.launchAtLogin,
    );
  } catch (_) {
    // Login startup is a convenience and can be blocked by enterprise policy.
  }
  NativeBridgeServer? bridge;
  try {
    bridge = NativeBridgeServer(manager: manager);
    await bridge.start();
  } catch (_) {
    // Browser integration is optional; a locked profile should not prevent
    // the download manager from starting.
    bridge = null;
  }
  for (final url in args.map(_startupUrl).whereType<String>()) {
    try {
      await manager.add(url: url);
    } catch (_) {
      // Ignore malformed shell/deep-link arguments and keep the UI usable.
    }
  }
  runApp(
    ArusApp(manager: manager, bridge: bridge, notifications: notifications),
  );
}

String? _startupUrl(String argument) {
  final raw = argument.startsWith('--add-url=')
      ? argument.substring('--add-url='.length)
      : argument;
  final uri = Uri.tryParse(raw);
  if (uri == null) {
    return null;
  }
  if (const <String>{
        'http',
        'https',
        'ftp',
      }.contains(uri.scheme.toLowerCase()) &&
      uri.host.isNotEmpty) {
    return raw;
  }
  if (uri.scheme.toLowerCase() == 'arus' && uri.host == 'download') {
    final url = uri.queryParameters['url'];
    return url != null && isSupportedUrl(url) ? url : null;
  }
  return null;
}

String _shortUrl(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null) {
    return value;
  }
  final compact = '${uri.host}${uri.path}';
  return compact.length <= 54 ? compact : '${compact.substring(0, 51)}…';
}

class ArusApp extends StatelessWidget {
  const ArusApp({
    super.key,
    required this.manager,
    this.bridge,
    this.notifications,
  });

  final DownloadManager manager;
  final NativeBridgeServer? bridge;
  final DesktopNotificationService? notifications;

  @override
  Widget build(BuildContext context) {
    final scheme =
        ColorScheme.fromSeed(
          seedColor: _primary,
          brightness: Brightness.dark,
        ).copyWith(
          primary: _primary,
          secondary: _secondary,
          surface: _panel,
          error: _error,
        );
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Arus',
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: scheme,
        scaffoldBackgroundColor: _background,
        canvasColor: _background,
        cardTheme: const CardThemeData(
          color: _panel,
          surfaceTintColor: Colors.transparent,
          margin: EdgeInsets.zero,
        ),
        dividerTheme: const DividerThemeData(color: _border, space: 1),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: _background,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: _border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: _border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: _primary, width: 1.4),
          ),
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 14,
            vertical: 13,
          ),
        ),
        dialogTheme: const DialogThemeData(
          backgroundColor: _panel,
          surfaceTintColor: Colors.transparent,
        ),
      ),
      home: ArusShell(
        manager: manager,
        bridge: bridge,
        notifications: notifications,
      ),
    );
  }
}

enum _Page { downloads, settings }

enum _Filter { all, active, queued, done, error }

extension on _Filter {
  String get label {
    switch (this) {
      case _Filter.all:
        return 'All';
      case _Filter.active:
        return 'Active';
      case _Filter.queued:
        return 'Queued';
      case _Filter.done:
        return 'Done';
      case _Filter.error:
        return 'Error';
    }
  }

  IconData get icon {
    switch (this) {
      case _Filter.all:
        return Icons.format_list_bulleted_rounded;
      case _Filter.active:
        return Icons.arrow_downward_rounded;
      case _Filter.queued:
        return Icons.schedule_rounded;
      case _Filter.done:
        return Icons.check_rounded;
      case _Filter.error:
        return Icons.error_outline_rounded;
    }
  }

  bool matches(DownloadTask task) {
    switch (this) {
      case _Filter.all:
        return true;
      case _Filter.active:
        return task.status == DownloadStatus.downloading ||
            task.status == DownloadStatus.paused;
      case _Filter.queued:
        return task.status == DownloadStatus.queued;
      case _Filter.done:
        return task.status == DownloadStatus.completed;
      case _Filter.error:
        return task.status == DownloadStatus.failed ||
            task.status == DownloadStatus.cancelled;
    }
  }
}

class ArusShell extends StatefulWidget {
  const ArusShell({
    super.key,
    required this.manager,
    this.bridge,
    this.notifications,
  });

  final DownloadManager manager;
  final NativeBridgeServer? bridge;
  final DesktopNotificationService? notifications;

  @override
  State<ArusShell> createState() => _ArusShellState();
}

class _ArusShellState extends State<ArusShell> with WindowListener {
  _Page _page = _Page.downloads;
  _Filter _filter = _Filter.all;
  final Set<String> _expanded = <String>{};
  late final ClipboardLinkMonitor _clipboardMonitor;
  StreamSubscription<String>? _clipboardSubscription;
  StreamSubscription<DownloadTask>? _completionSubscription;
  late final ArusTrayController _tray;
  late bool _lastMinimizeToTray;

  DownloadManager get manager => widget.manager;

  @override
  void initState() {
    super.initState();
    _lastMinimizeToTray = manager.settings.minimizeToTray;
    manager.addListener(_cleanSelection);
    _clipboardMonitor = ClipboardLinkMonitor();
    _clipboardSubscription = _clipboardMonitor.links.listen(_onClipboardLink);
    _clipboardMonitor.start();
    _completionSubscription = manager.completed.listen((task) {
      final notifications = widget.notifications;
      if (notifications != null) {
        unawaited(notifications.completed(task));
      }
    });
    _tray = ArusTrayController(
      onShow: () async {
        await windowManager.show();
        await windowManager.focus();
      },
      onExit: windowManager.destroy,
    );
    windowManager.addListener(this);
    unawaited(_initializeDesktopLifecycle());
  }

  Future<void> _initializeDesktopLifecycle() async {
    try {
      await windowManager.setPreventClose(manager.settings.minimizeToTray);
      await _tray.initialize();
    } catch (_) {
      // The app remains fully usable without a tray plugin on unsupported
      // hosts or during widget tests.
    }
  }

  @override
  void onWindowClose() {
    if (manager.settings.minimizeToTray && _tray.isReady) {
      unawaited(windowManager.hide());
    } else {
      unawaited(windowManager.destroy());
    }
  }

  @override
  void dispose() {
    manager.removeListener(_cleanSelection);
    unawaited(_clipboardSubscription?.cancel());
    unawaited(_completionSubscription?.cancel());
    _clipboardMonitor.dispose();
    windowManager.removeListener(this);
    unawaited(_tray.dispose());
    final bridge = widget.bridge;
    if (bridge != null) {
      unawaited(bridge.stop());
    }
    super.dispose();
  }

  void _onClipboardLink(String url) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text('Tautan terdeteksi: ${_shortUrl(url)}'),
          behavior: SnackBarBehavior.floating,
          action: SnackBarAction(
            label: 'Tambah',
            onPressed: () => _run(() => manager.add(url: url)),
          ),
        ),
      );
  }

  void _cleanSelection() {
    final minimizeToTray = manager.settings.minimizeToTray;
    if (minimizeToTray != _lastMinimizeToTray) {
      _lastMinimizeToTray = minimizeToTray;
      unawaited(_setWindowPolicy(minimizeToTray));
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(error.toString().replaceFirst('Exception: ', '')),
          backgroundColor: _error,
        ),
      );
    }
  }

  Future<void> _setWindowPolicy(bool minimizeToTray) async {
    try {
      await windowManager.setPreventClose(minimizeToTray);
    } catch (_) {
      // Window control is optional during tests and on non-desktop targets.
    }
  }

  void _showAddDialog() {
    showDialog<void>(
      context: context,
      builder: (_) => _AddDownloadDialog(manager: manager),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: manager,
      builder: (context, _) {
        final tasks = manager.tasks;
        final activeSpeed = tasks
            .where((task) => task.status == DownloadStatus.downloading)
            .fold<int>(0, (sum, task) => sum + task.speedBytesPerSecond);
        final counts = <_Filter, int>{
          for (final filter in _Filter.values)
            filter: tasks.where(filter.matches).length,
        };
        return Scaffold(
          body: SafeArea(
            child: Row(
              children: <Widget>[
                _Sidebar(
                  page: _page,
                  filter: _filter,
                  counts: counts,
                  onSelect: (page) => setState(() => _page = page),
                  onFilter: (filter) => setState(() {
                    _page = _Page.downloads;
                    _filter = filter;
                  }),
                ),
                Expanded(
                  child: Column(
                    children: <Widget>[
                      _TopBar(
                        page: _page,
                        speed: activeSpeed,
                        onAdd: _showAddDialog,
                        onSettings: () =>
                            setState(() => _page = _Page.settings),
                      ),
                      Expanded(
                        child: _page == _Page.downloads
                            ? _buildDownloads(tasks)
                            : _SettingsView(
                                manager: manager,
                                onBack: () =>
                                    setState(() => _page = _Page.downloads),
                              ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildDownloads(List<DownloadTask> tasks) {
    final visible = tasks.where(_filter.matches).toList();
    if (visible.isEmpty) {
      return ListView(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
        children: const <Widget>[_EmptyState()],
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 28),
      itemCount: visible.length,
      separatorBuilder: (_, _) => const SizedBox(height: 1),
      itemBuilder: (context, index) {
        final task = visible[index];
        return _DownloadCard(
          task: task,
          expanded: _expanded.contains(task.id),
          onToggleExpanded: () {
            setState(() {
              if (!_expanded.add(task.id)) {
                _expanded.remove(task.id);
              }
            });
          },
          onPause: () => _run(() => manager.pause(task.id)),
          onResume: () => _run(() => manager.resume(task.id)),
          onCancel: () => _run(() => manager.cancel(task.id)),
          onReveal: () => _run(() => manager.revealInFolder(task.id)),
          onRemove: () => _confirmRemove(task),
        );
      },
    );
  }

  Future<void> _confirmRemove(DownloadTask task) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Hapus dari daftar?'),
        content: Text(
          '“${task.fileName}” akan dihapus dari daftar unduhan. '
          'File hasil unduhan yang sudah ada tidak akan dihapus.',
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Batal'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: _error,
              foregroundColor: _text,
            ),
            child: const Text('Hapus dari daftar'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) {
      return;
    }
    await _run(() => manager.remove(task.id));
    if (mounted) {
      setState(() => _expanded.remove(task.id));
    }
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({
    required this.page,
    required this.filter,
    required this.counts,
    required this.onSelect,
    required this.onFilter,
  });

  final _Page page;
  final _Filter filter;
  final Map<_Filter, int> counts;
  final ValueChanged<_Page> onSelect;
  final ValueChanged<_Filter> onFilter;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 146,
      decoration: const BoxDecoration(
        color: _panel,
        border: Border(right: BorderSide(color: _border)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 0),
            child: Row(
              children: <Widget>[
                Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: _primary.withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: _primary.withValues(alpha: 0.38)),
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: Image.asset(
                    'assets/arus_logo.png',
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stackTrace) => const Icon(
                      Icons.bolt_rounded,
                      color: _primary,
                      size: 17,
                    ),
                  ),
                ),
                const SizedBox(width: 9),
                const Text(
                  'Arus',
                  style: TextStyle(
                    color: _text,
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 30),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 18),
            child: Text(
              'LIBRARY',
              style: TextStyle(
                color: _muted,
                fontSize: 9,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.2,
              ),
            ),
          ),
          const SizedBox(height: 8),
          for (final item in _Filter.values)
            _SidebarFilterButton(
              filter: item,
              count: counts[item] ?? 0,
              selected: page == _Page.downloads && filter == item,
              onPressed: () => onFilter(item),
            ),
          const Spacer(),
          const Divider(height: 1),
          const SizedBox(height: 8),
          _NavButton(
            icon: Icons.settings_outlined,
            label: 'Settings',
            selected: page == _Page.settings,
            onPressed: () => onSelect(_Page.settings),
          ),
          const SizedBox(height: 10),
        ],
      ),
    );
  }
}

class _SidebarFilterButton extends StatelessWidget {
  const _SidebarFilterButton({
    required this.filter,
    required this.count,
    required this.selected,
    required this.onPressed,
  });

  final _Filter filter;
  final int count;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final foreground = selected ? _text : _muted;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      child: Material(
        color: selected ? _primary.withValues(alpha: 0.12) : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(7),
          child: SizedBox(
            height: 37,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 9),
              child: Row(
                children: <Widget>[
                  Icon(
                    filter.icon,
                    size: 16,
                    color: selected ? _primary : foreground,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      filter.label,
                      style: TextStyle(
                        color: foreground,
                        fontSize: 12,
                        fontWeight: selected
                            ? FontWeight.w700
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                  Text(
                    '$count',
                    style: TextStyle(
                      color: selected
                          ? _primary
                          : _muted.withValues(alpha: 0.8),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      child: Material(
        color: selected ? _primary.withValues(alpha: 0.12) : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(7),
          child: SizedBox(
            height: 37,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 9),
              child: Row(
                children: <Widget>[
                  Icon(icon, size: 17, color: selected ? _primary : _muted),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: selected ? _text : _muted,
                        fontSize: 12,
                        fontWeight: selected
                            ? FontWeight.w700
                            : FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.page,
    required this.speed,
    required this.onAdd,
    required this.onSettings,
  });

  final _Page page;
  final int speed;
  final VoidCallback onAdd;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final downloads = page == _Page.downloads;
    return Container(
      height: 58,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      decoration: const BoxDecoration(
        color: _background,
        border: Border(bottom: BorderSide(color: _border)),
      ),
      child: Row(
        children: <Widget>[
          Icon(
            downloads ? Icons.download_rounded : Icons.settings_outlined,
            color: downloads ? _text : _muted,
            size: 18,
          ),
          const SizedBox(width: 9),
          Text(
            downloads ? 'Downloads' : 'Settings',
            style: const TextStyle(
              color: _text,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
          ),
          const Spacer(),
          if (downloads) ...<Widget>[
            Text(
              formatSpeed(speed),
              style: const TextStyle(
                color: _muted,
                fontSize: 11,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(width: 14),
          ],
          IconButton(
            onPressed: onSettings,
            tooltip: 'Settings',
            icon: const Icon(Icons.settings_outlined, color: _muted, size: 18),
          ),
          const SizedBox(width: 5),
          FilledButton.icon(
            onPressed: onAdd,
            icon: const Icon(Icons.add_rounded, size: 17),
            label: const Text('Add download'),
            style: FilledButton.styleFrom(
              backgroundColor: _primary,
              foregroundColor: _background,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              textStyle: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ignore: unused_element
class _SpeedHero extends StatelessWidget {
  const _SpeedHero({
    required this.active,
    required this.queued,
    required this.speed,
    required this.peak,
    required this.onAdd,
    required this.onSettings,
  });

  final int active;
  final int queued;
  final int speed;
  final int peak;
  final VoidCallback onAdd;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    final speedText = formatSpeed(speed);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 600;
            return Flex(
              direction: compact ? Axis.vertical : Axis.horizontal,
              crossAxisAlignment: compact
                  ? CrossAxisAlignment.stretch
                  : CrossAxisAlignment.center,
              children: <Widget>[
                Expanded(
                  flex: compact ? 0 : 3,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Row(
                        children: <Widget>[
                          const Text(
                            'KECEPATAN GABUNGAN',
                            style: TextStyle(
                              color: _muted,
                              fontSize: 11,
                              letterSpacing: 1.3,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const Spacer(),
                          IconButton(
                            onPressed: onSettings,
                            tooltip: 'Koneksi paralel',
                            icon: const Icon(
                              Icons.tune_rounded,
                              color: _muted,
                              size: 18,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        speedText,
                        style: const TextStyle(
                          color: _text,
                          fontSize: 34,
                          height: 1,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -1,
                        ),
                      ),
                      const SizedBox(height: 18),
                      Wrap(
                        spacing: 10,
                        runSpacing: 8,
                        children: <Widget>[
                          _StatPill(
                            label: 'Aktif',
                            value: '$active',
                            accent: _secondary,
                          ),
                          _StatPill(label: 'Antrean', value: '$queued'),
                          _StatPill(label: 'Puncak', value: formatSpeed(peak)),
                        ],
                      ),
                    ],
                  ),
                ),
                if (!compact) const SizedBox(width: 24),
                _SpeedGauge(speed: speed, compact: compact),
                if (compact) ...<Widget>[
                  const SizedBox(height: 18),
                  OutlinedButton.icon(
                    onPressed: onAdd,
                    icon: const Icon(Icons.add_rounded, size: 18),
                    label: const Text('Tambah unduhan'),
                    style: OutlinedButton.styleFrom(foregroundColor: _primary),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }
}

class _StatPill extends StatelessWidget {
  const _StatPill({required this.label, required this.value, this.accent});

  final String label;
  final String value;
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: _background,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: _border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(label, style: const TextStyle(color: _muted, fontSize: 11)),
          const SizedBox(width: 8),
          Text(
            value,
            style: TextStyle(
              color: accent ?? _text,
              fontSize: 12,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _SpeedGauge extends StatelessWidget {
  const _SpeedGauge({required this.speed, required this.compact});

  final int speed;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final value = math.min(1.0, speed / (100 * 1024 * 1024));
    return SizedBox(
      width: compact ? 132 : 148,
      height: compact ? 132 : 148,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          SizedBox(
            width: compact ? 116 : 130,
            height: compact ? 116 : 130,
            child: CircularProgressIndicator(
              value: value,
              strokeWidth: 8,
              backgroundColor: _border,
              color: speed > 0 ? _secondary : _muted.withValues(alpha: 0.45),
              strokeCap: StrokeCap.round,
            ),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                Icons.speed_rounded,
                color: speed > 0 ? _secondary : _muted,
                size: 22,
              ),
              const SizedBox(height: 4),
              Text(
                speed > 0 ? 'AKTIF' : 'SIAP',
                style: const TextStyle(
                  color: _muted,
                  fontSize: 10,
                  letterSpacing: 1.2,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ignore: unused_element
class _ActionBar extends StatelessWidget {
  const _ActionBar({
    required this.selectedCount,
    required this.allSelected,
    required this.canPause,
    required this.canResume,
    required this.hasActive,
    required this.hasCompleted,
    required this.onToggleAll,
    required this.onPause,
    required this.onResume,
    required this.onPauseAll,
    required this.onRemove,
    required this.onRemoveCompleted,
  });

  final int selectedCount;
  final bool allSelected;
  final bool canPause;
  final bool canResume;
  final bool hasActive;
  final bool hasCompleted;
  final VoidCallback onToggleAll;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onPauseAll;
  final VoidCallback onRemove;
  final VoidCallback onRemoveCompleted;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: <Widget>[
        Checkbox(
          value: allSelected,
          tristate: true,
          onChanged: (_) => onToggleAll(),
          activeColor: _primary,
          checkColor: _background,
        ),
        Text(
          selectedCount > 0 ? '$selectedCount dipilih' : 'Pilih semua',
          style: const TextStyle(color: _muted, fontSize: 12),
        ),
        const Spacer(),
        if (selectedCount > 0 && canPause)
          _ToolbarButton(
            icon: Icons.pause_rounded,
            label: 'Jeda',
            onPressed: onPause,
          ),
        if (selectedCount > 0 && canResume)
          _ToolbarButton(
            icon: Icons.play_arrow_rounded,
            label: 'Lanjut',
            onPressed: onResume,
          ),
        if (selectedCount > 0)
          _ToolbarButton(
            icon: Icons.delete_outline_rounded,
            label: 'Hapus',
            onPressed: onRemove,
            danger: true,
          ),
        if (selectedCount == 0 && hasActive)
          _ToolbarButton(
            icon: Icons.pause_circle_outline_rounded,
            label: 'Jeda semua',
            onPressed: onPauseAll,
          ),
        if (selectedCount == 0 && hasCompleted)
          _ToolbarButton(
            icon: Icons.cleaning_services_outlined,
            label: 'Bersihkan selesai',
            onPressed: onRemoveCompleted,
          ),
      ],
    );
  }
}

class _ToolbarButton extends StatelessWidget {
  const _ToolbarButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.danger = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 6),
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: Icon(icon, size: 16),
        label: Text(label),
        style: OutlinedButton.styleFrom(
          foregroundColor: danger ? _error : _muted,
          side: BorderSide(
            color: danger ? _error.withValues(alpha: 0.5) : _border,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          textStyle: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 58, horizontal: 24),
        child: Column(
          children: <Widget>[
            Icon(
              Icons.download_for_offline_outlined,
              color: _muted.withValues(alpha: 0.55),
              size: 42,
            ),
            const SizedBox(height: 14),
            const Text(
              'Belum ada unduhan di sini.',
              style: TextStyle(color: _muted, fontSize: 13),
            ),
            const SizedBox(height: 6),
            const Text(
              'Tambahkan URL untuk memulai unduhan dengan koneksi paralel.',
              textAlign: TextAlign.center,
              style: TextStyle(color: _muted, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}

class _DownloadCard extends StatelessWidget {
  const _DownloadCard({
    required this.task,
    required this.expanded,
    required this.onToggleExpanded,
    required this.onPause,
    required this.onResume,
    required this.onCancel,
    required this.onReveal,
    required this.onRemove,
  });

  final DownloadTask task;
  final bool expanded;
  final VoidCallback onToggleExpanded;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onCancel;
  final VoidCallback onReveal;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final showsProgress =
        task.status == DownloadStatus.downloading ||
        task.status == DownloadStatus.paused;
    return Card(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: _panel,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(4),
        side: const BorderSide(color: _border, width: 0.7),
      ),
      child: Column(
        children: <Widget>[
          InkWell(
            onTap: onToggleExpanded,
            borderRadius: expanded
                ? const BorderRadius.vertical(top: Radius.circular(4))
                : BorderRadius.circular(4),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 13, 10, 11),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: <Widget>[
                      _FileTypeIcon(task: task),
                      const SizedBox(width: 11),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: <Widget>[
                            Text(
                              task.fileName,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: task.status == DownloadStatus.cancelled
                                    ? _muted
                                    : _text,
                                fontWeight: FontWeight.w700,
                                fontSize: 13,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              _taskSize(task),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: _muted,
                                fontSize: 11,
                                fontFamily: 'monospace',
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 10),
                      _StatusChip(status: task.status),
                    ],
                  ),
                  if (showsProgress) ...<Widget>[
                    const SizedBox(height: 10),
                    _SegmentedProgressBar(task: task),
                    const SizedBox(height: 8),
                    Text(
                      _taskMeta(task),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: _muted,
                        fontSize: 11,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ] else ...<Widget>[
                    const SizedBox(height: 6),
                    Text(
                      _taskMeta(task),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: task.status == DownloadStatus.failed
                            ? _error
                            : _muted,
                        fontSize: 11,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ],
                  const SizedBox(height: 9),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: <Widget>[
                      _StatusActions(
                        status: task.status,
                        onPause: onPause,
                        onResume: onResume,
                        onCancel: onCancel,
                        onReveal: onReveal,
                        onRemove: onRemove,
                      ),
                      const SizedBox(width: 6),
                      _SmallIconButton(
                        icon: expanded
                            ? Icons.keyboard_arrow_up_rounded
                            : Icons.keyboard_arrow_down_rounded,
                        tooltip: expanded ? 'Hide details' : 'Show details',
                        color: _muted,
                        onPressed: onToggleExpanded,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
          if (expanded) _DownloadDetails(task: task),
        ],
      ),
    );
  }
}

String _taskMeta(DownloadTask task) {
  final total = task.totalBytes == null ? '?' : formatBytes(task.totalBytes!);
  final connections = task.segments == null || task.segments!.isEmpty
      ? 1
      : task.segments!.length;
  switch (task.status) {
    case DownloadStatus.downloading:
      final speed = task.speedBytesPerSecond > 0
          ? formatSpeed(task.speedBytesPerSecond)
          : 'starting';
      final remaining = task.totalBytes == null
          ? 'ETA —'
          : 'ETA ${formatEta(math.max(0, task.totalBytes! - task.bytesReceived), task.speedBytesPerSecond)}';
      return '$speed · $connections connections · $remaining';
    case DownloadStatus.queued:
      return '$total · waiting in queue';
    case DownloadStatus.completed:
      return '$total · finished';
    case DownloadStatus.paused:
      return '${task.progress.round()}% · paused';
    case DownloadStatus.failed:
      return task.error?.isNotEmpty == true ? task.error! : 'connection lost';
    case DownloadStatus.cancelled:
      return 'cancelled';
  }
}

String _taskSize(DownloadTask task) {
  if (task.totalBytes != null) {
    return formatBytes(task.totalBytes!);
  }
  if (task.bytesReceived > 0) {
    return '${formatBytes(task.bytesReceived)} downloaded';
  }
  return 'size unknown';
}

Color _statusColor(DownloadStatus status) {
  return switch (status) {
    DownloadStatus.downloading => _activeBlue,
    DownloadStatus.queued => _muted,
    DownloadStatus.completed => _success,
    DownloadStatus.failed => _error,
    DownloadStatus.paused || DownloadStatus.cancelled => _muted,
  };
}

String _statusLabel(DownloadStatus status) {
  return switch (status) {
    DownloadStatus.downloading => 'active',
    DownloadStatus.queued => 'queued',
    DownloadStatus.completed => 'done',
    DownloadStatus.failed => 'error',
    DownloadStatus.paused => 'paused',
    DownloadStatus.cancelled => 'cancelled',
  };
}

class _FileTypeIcon extends StatelessWidget {
  const _FileTypeIcon({required this.task});

  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final extension = task.fileName.contains('.')
        ? task.fileName.split('.').last.toLowerCase()
        : '';
    final icon = switch (extension) {
      'zip' || '7z' || 'rar' => Icons.archive_outlined,
      'iso' || 'img' => Icons.album_outlined,
      'mp4' || 'mkv' || 'mov' || 'avi' => Icons.videocam_outlined,
      'mp3' || 'wav' || 'flac' => Icons.headphones_outlined,
      'exe' || 'msi' => Icons.apps_outlined,
      'csv' || 'json' || 'xml' => Icons.data_object_outlined,
      'pdf' => Icons.picture_as_pdf_outlined,
      _ => Icons.insert_drive_file_outlined,
    };
    return SizedBox(
      width: 25,
      height: 25,
      child: Icon(icon, color: _statusColor(task.status), size: 18),
    );
  }
}

class _SegmentedProgressBar extends StatelessWidget {
  const _SegmentedProgressBar({required this.task});

  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final segments = task.segments;
    if (segments == null || segments.isEmpty) {
      return _ProgressTrack(value: (task.progress / 100).clamp(0, 1));
    }
    return SizedBox(
      height: 6,
      child: Row(
        children: <Widget>[
          for (var index = 0; index < segments.length; index += 1) ...<Widget>[
            if (index > 0) const SizedBox(width: 4),
            Expanded(child: _ProgressTrack(value: segments[index].progress)),
          ],
        ],
      ),
    );
  }
}

class _ProgressTrack extends StatelessWidget {
  const _ProgressTrack({required this.value});

  final double value;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(2),
      child: LinearProgressIndicator(
        value: value,
        minHeight: 5,
        backgroundColor: _border,
        color: _activeBlue,
      ),
    );
  }
}

class _StatusActions extends StatelessWidget {
  const _StatusActions({
    required this.status,
    required this.onPause,
    required this.onResume,
    required this.onCancel,
    required this.onReveal,
    required this.onRemove,
  });

  final DownloadStatus status;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onCancel;
  final VoidCallback onReveal;
  final VoidCallback onRemove;

  Widget _removeButton() {
    return _SmallIconButton(
      icon: Icons.delete_outline_rounded,
      tooltip: 'Remove from list',
      color: _error,
      onPressed: onRemove,
    );
  }

  @override
  Widget build(BuildContext context) {
    switch (status) {
      case DownloadStatus.downloading:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _SmallIconButton(
              icon: Icons.pause_rounded,
              tooltip: 'Pause',
              color: _muted,
              onPressed: onPause,
            ),
            const SizedBox(width: 6),
            _SmallIconButton(
              icon: Icons.close_rounded,
              tooltip: 'Cancel',
              color: _muted,
              onPressed: onCancel,
            ),
            const SizedBox(width: 6),
            _removeButton(),
          ],
        );
      case DownloadStatus.paused:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _SmallIconButton(
              icon: Icons.play_arrow_rounded,
              tooltip: 'Resume',
              color: _secondary,
              onPressed: onResume,
            ),
            const SizedBox(width: 6),
            _SmallIconButton(
              icon: Icons.close_rounded,
              tooltip: 'Cancel',
              color: _muted,
              onPressed: onCancel,
            ),
            const SizedBox(width: 6),
            _removeButton(),
          ],
        );
      case DownloadStatus.queued:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _SmallIconButton(
              icon: Icons.close_rounded,
              tooltip: 'Cancel',
              color: _muted,
              onPressed: onCancel,
            ),
            const SizedBox(width: 6),
            _removeButton(),
          ],
        );
      case DownloadStatus.failed:
      case DownloadStatus.cancelled:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            OutlinedButton.icon(
              onPressed: onResume,
              icon: const Icon(Icons.refresh_rounded, size: 14),
              label: const Text('Retry'),
              style: OutlinedButton.styleFrom(
                foregroundColor: _text,
                side: const BorderSide(color: _border),
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                textStyle: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            const SizedBox(width: 6),
            _removeButton(),
          ],
        );
      case DownloadStatus.completed:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            _SmallIconButton(
              icon: Icons.folder_outlined,
              tooltip: 'Open folder',
              color: _muted,
              onPressed: onReveal,
            ),
            const SizedBox(width: 6),
            _removeButton(),
          ],
        );
    }
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final DownloadStatus status;

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.11),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        _statusLabel(status),
        style: TextStyle(
          color: color,
          fontSize: 10,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _SmallIconButton extends StatelessWidget {
  const _SmallIconButton({
    required this.icon,
    required this.tooltip,
    required this.color,
    required this.onPressed,
  });

  final IconData icon;
  final String tooltip;
  final Color color;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onPressed,
      tooltip: tooltip,
      visualDensity: VisualDensity.compact,
      iconSize: 17,
      color: color,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(width: 31, height: 31),
      style: IconButton.styleFrom(
        foregroundColor: color,
        side: const BorderSide(color: _border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),
      icon: Icon(icon),
    );
  }
}

class _DownloadDetails extends StatelessWidget {
  const _DownloadDetails({required this.task});

  final DownloadTask task;

  @override
  Widget build(BuildContext context) {
    final segments = task.segments;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(18, 4, 16, 16),
      decoration: const BoxDecoration(
        color: _background,
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Divider(),
          const SizedBox(height: 12),
          _DetailLine(label: 'URL', value: task.url),
          const SizedBox(height: 8),
          _DetailLine(label: 'Lokasi', value: task.filePath),
          const SizedBox(height: 8),
          _DetailLine(
            label: 'Estimasi',
            value: task.totalBytes == null
                ? 'Ukuran belum diketahui'
                : '${formatEta(math.max(0, task.totalBytes! - task.bytesReceived), task.speedBytesPerSecond)} tersisa',
          ),
          const SizedBox(height: 14),
          if (segments == null || segments.isEmpty)
            const Text(
              'Unduhan single-connection — server tidak menyediakan segmen paralel.',
              style: TextStyle(color: _muted, fontSize: 11),
            )
          else ...<Widget>[
            const Text(
              'UNDUHAN PARALEL',
              style: TextStyle(
                color: _muted,
                fontSize: 10,
                letterSpacing: 1.1,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 8),
            for (final segment in segments) _SegmentLine(segment: segment),
          ],
          if (task.error != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(
              task.error!,
              style: const TextStyle(color: _error, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}

class _DetailLine extends StatelessWidget {
  const _DetailLine({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        SizedBox(
          width: 68,
          child: Text(
            label,
            style: const TextStyle(color: _muted, fontSize: 10),
          ),
        ),
        Expanded(
          child: SelectableText(
            value,
            maxLines: 2,
            style: const TextStyle(
              color: _text,
              fontSize: 11,
              fontFamily: 'monospace',
            ),
          ),
        ),
      ],
    );
  }
}

class _SegmentLine extends StatelessWidget {
  const _SegmentLine({required this.segment});

  final DownloadSegment segment;

  @override
  Widget build(BuildContext context) {
    final percent = segment.progress;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 28,
            child: Text(
              '#${segment.index + 1}',
              style: const TextStyle(color: _muted, fontSize: 10),
            ),
          ),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: percent,
                minHeight: 5,
                backgroundColor: _border,
                color: percent >= 1 ? _success : _secondary,
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            width: 105,
            child: Text(
              '${formatBytes(segment.downloaded)} / ${formatBytes(segment.length)}',
              textAlign: TextAlign.right,
              style: const TextStyle(
                color: _muted,
                fontSize: 10,
                fontFamily: 'monospace',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsView extends StatelessWidget {
  const _SettingsView({required this.manager, required this.onBack});

  final DownloadManager manager;
  final VoidCallback onBack;

  Future<void> _update(
    Future<void> Function() action,
    BuildContext context,
  ) async {
    try {
      await action();
    } catch (error) {
      if (!context.mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString()), backgroundColor: _error),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final settings = manager.settings;
    return ListView(
      padding: const EdgeInsets.fromLTRB(28, 24, 28, 32),
      children: <Widget>[
        Row(
          children: <Widget>[
            IconButton(
              onPressed: onBack,
              icon: const Icon(Icons.arrow_back_rounded, color: _muted),
            ),
            const SizedBox(width: 6),
            const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  'Preferensi Arus',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700),
                ),
                SizedBox(height: 4),
                Text(
                  'Atur performa unduhan dan perilaku aplikasi.',
                  style: TextStyle(color: _muted, fontSize: 12),
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 24),
        _SettingsSection(
          title: 'Performa unduhan',
          subtitle:
              'Gunakan koneksi paralel untuk server yang mendukung Range.',
          children: <Widget>[
            _SliderSetting(
              title: 'Koneksi per file',
              description: 'Jumlah segmen paralel untuk setiap unduhan.',
              value: settings.connections.toDouble(),
              min: 4,
              max: 16,
              divisions: 12,
              valueLabel: '${settings.connections} koneksi',
              onChanged: (value) => _update(
                () => manager.updateSettings(connections: value.round()),
                context,
              ),
            ),
            _SliderSetting(
              title: 'Unduhan bersamaan',
              description: 'Batas file yang berjalan pada waktu yang sama.',
              value: settings.maxConcurrentDownloads.toDouble(),
              min: 1,
              max: 10,
              divisions: 9,
              valueLabel: '${settings.maxConcurrentDownloads} file',
              onChanged: (value) => _update(
                () => manager.updateSettings(
                  maxConcurrentDownloads: value.round(),
                ),
                context,
              ),
            ),
            _SliderSetting(
              title: 'Percobaan ulang',
              description:
                  'Retry saat koneksi putus atau server mengembalikan error sementara.',
              value: settings.maxSegmentRetries.toDouble(),
              min: 0,
              max: 10,
              divisions: 10,
              valueLabel: '${settings.maxSegmentRetries} kali',
              onChanged: (value) => _update(
                () => manager.updateSettings(maxSegmentRetries: value.round()),
                context,
              ),
            ),
            _SliderSetting(
              title: 'Batas kecepatan',
              description:
                  'Batas total untuk semua unduhan aktif. Nol berarti tanpa batas.',
              value: (settings.speedLimitBytesPerSecond / (1024 * 1024))
                  .clamp(0, 100)
                  .toDouble(),
              min: 0,
              max: 100,
              divisions: 20,
              valueLabel: settings.speedLimitBytesPerSecond == 0
                  ? 'Tanpa batas'
                  : '${(settings.speedLimitBytesPerSecond / (1024 * 1024)).round()} MB/s',
              onChanged: (value) => _update(
                () => manager.updateSettings(
                  speedLimitBytesPerSecond: value.round() * 1024 * 1024,
                ),
                context,
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _SettingsSection(
          title: 'Perilaku aplikasi',
          subtitle: 'Pilihan ini disimpan untuk sesi berikutnya.',
          children: <Widget>[
            _SwitchSetting(
              title: 'Tampilkan file saat selesai',
              description: 'Buka folder tujuan setelah unduhan selesai.',
              value: settings.revealOnComplete,
              onChanged: (value) => _update(
                () => manager.updateSettings(revealOnComplete: value),
                context,
              ),
            ),
            _SwitchSetting(
              title: 'Jalankan saat login',
              description: 'Siapkan Arus ketika Windows mulai.',
              value: settings.launchAtLogin,
              onChanged: (value) => _update(
                () => manager.updateSettings(launchAtLogin: value),
                context,
              ),
            ),
            _SwitchSetting(
              title: 'Minimalkan ke system tray',
              description:
                  'Tutup jendela ke tray agar antrean tetap berjalan di latar.',
              value: settings.minimizeToTray,
              onChanged: (value) => _update(
                () => manager.updateSettings(minimizeToTray: value),
                context,
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _SettingsSection(
          title: 'Integrasi browser',
          subtitle:
              'Terima URL dari ekstensi melalui Native Messaging loopback.',
          children: <Widget>[
            _SwitchSetting(
              title: 'Terima unduhan dari browser',
              description:
                  'Ekstensi aktif meneruskan URL, cookie, dan referrer ke antrean Arus.',
              value: settings.browserIntegrationEnabled,
              onChanged: (value) => _update(
                () => manager.updateSettings(browserIntegrationEnabled: value),
                context,
              ),
            ),
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: () => _update(manager.installNativeHost, context),
                icon: const Icon(Icons.extension_outlined, size: 16),
                label: const Text('Pasang ulang native host'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: _secondary,
                  side: BorderSide(color: _secondary.withValues(alpha: 0.45)),
                ),
              ),
            ),
            Container(
              margin: const EdgeInsets.only(top: 6),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: _primary.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: _primary.withValues(alpha: 0.24)),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Icon(Icons.info_outline_rounded, color: _primary, size: 17),
                  SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Ekstensi mengirim URL melalui Native Messaging ke bridge loopback Arus. Pasang host sekali setelah setiap instalasi atau perpindahan folder aplikasi.',
                      style: TextStyle(
                        color: _muted,
                        fontSize: 11,
                        height: 1.45,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _SettingsSection(
          title: 'Penyimpanan',
          subtitle:
              'Folder baru dibuat otomatis sebelum probe dan setiap retry.',
          children: <Widget>[
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.folder_outlined, color: _secondary),
              title: const Text(
                'Folder unduhan default',
                style: TextStyle(fontSize: 13),
              ),
              subtitle: Text(
                manager.defaultDirectory,
                style: const TextStyle(color: _muted, fontSize: 11),
              ),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.save_outlined, color: _secondary),
              title: const Text(
                'Resume metadata',
                style: TextStyle(fontSize: 13),
              ),
              subtitle: const Text(
                'Queue, status, segmen, dan progress disimpan lokal agar dapat dilanjutkan.',
                style: TextStyle(color: _muted, fontSize: 11),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _SettingsSection extends StatelessWidget {
  const _SettingsSection({
    required this.title,
    required this.subtitle,
    required this.children,
  });

  final String title;
  final String subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              title,
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
              subtitle,
              style: const TextStyle(color: _muted, fontSize: 11, height: 1.4),
            ),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _SliderSetting extends StatelessWidget {
  const _SliderSetting({
    required this.title,
    required this.description,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.valueLabel,
    required this.onChanged,
  });

  final String title;
  final String description;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String valueLabel;
  final ValueChanged<double> onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      description,
                      style: const TextStyle(color: _muted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              Text(
                valueLabel,
                style: const TextStyle(
                  color: _primary,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
          Slider(
            value: value.clamp(min, max),
            min: min,
            max: max,
            divisions: divisions,
            label: valueLabel,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }
}

class _SwitchSetting extends StatelessWidget {
  const _SwitchSetting({
    required this.title,
    required this.description,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String description;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(
        title,
        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        description,
        style: const TextStyle(color: _muted, fontSize: 11, height: 1.35),
      ),
      value: value,
      onChanged: onChanged,
      activeThumbColor: _secondary,
      activeTrackColor: _secondary.withValues(alpha: 0.35),
    );
  }
}

class _AddDownloadDialog extends StatefulWidget {
  const _AddDownloadDialog({required this.manager});

  final DownloadManager manager;

  @override
  State<_AddDownloadDialog> createState() => _AddDownloadDialogState();
}

class _AddDownloadDialogState extends State<_AddDownloadDialog> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _urlController;
  late final TextEditingController _fileController;
  late final TextEditingController _directoryController;
  String? _formError;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController();
    _fileController = TextEditingController();
    _directoryController = TextEditingController(
      text: widget.manager.defaultDirectory,
    );
  }

  @override
  void dispose() {
    _urlController.dispose();
    _fileController.dispose();
    _directoryController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    setState(() {
      _saving = true;
      _formError = null;
    });
    try {
      await widget.manager.add(
        url: _urlController.text,
        fileName: _fileController.text.trim().isEmpty
            ? null
            : _fileController.text,
        directory: _directoryController.text,
      );
      if (mounted) {
        Navigator.of(context).pop();
      }
    } catch (error) {
      if (!mounted) {
        return;
      }
      setState(() {
        _saving = false;
        _formError = error.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Unduhan baru'),
      content: SizedBox(
        width: 560,
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              TextFormField(
                controller: _urlController,
                autofocus: true,
                enabled: !_saving,
                decoration: const InputDecoration(
                  labelText: 'URL',
                  hintText: 'https://example.com/file.zip',
                  prefixIcon: Icon(Icons.link_rounded),
                ),
                validator: (value) {
                  final uri = Uri.tryParse(value?.trim() ?? '');
                  if (uri == null || !isSupportedUrl(uri.toString())) {
                    return 'Masukkan URL HTTP, HTTPS, atau FTP yang valid';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _fileController,
                enabled: !_saving,
                decoration: const InputDecoration(
                  labelText: 'Nama file (opsional)',
                  hintText: 'Diambil dari URL jika kosong',
                  prefixIcon: Icon(Icons.description_outlined),
                ),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _directoryController,
                enabled: !_saving,
                decoration: const InputDecoration(
                  labelText: 'Folder tujuan',
                  prefixIcon: Icon(Icons.folder_outlined),
                  helperText: 'Folder akan dibuat otomatis bila belum ada.',
                ),
              ),
              if (_formError != null) ...<Widget>[
                const SizedBox(height: 10),
                Text(
                  _formError!,
                  style: const TextStyle(color: _error, fontSize: 11),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
          child: const Text('Batal'),
        ),
        FilledButton.icon(
          onPressed: _saving ? null : _submit,
          icon: _saving
              ? const SizedBox(
                  width: 15,
                  height: 15,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.download_rounded, size: 17),
          label: const Text('Mulai unduh'),
          style: FilledButton.styleFrom(
            backgroundColor: _primary,
            foregroundColor: _background,
          ),
        ),
      ],
    );
  }
}
