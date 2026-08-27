import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'src/core/path_utils.dart';
import 'src/models/download_models.dart';
import 'src/services/app_storage.dart';
import 'src/services/download_manager.dart';

const _background = Color(0xFF12181F);
const _panel = Color(0xFF1E2630);
const _border = Color(0xFF2A3541);
const _primary = Color(0xFFF0A63F);
const _secondary = Color(0xFF2DD4BF);
const _success = Color(0xFF6FCF8E);
const _error = Color(0xFFE2574C);
const _text = Color(0xFFE9EEF5);
const _muted = Color(0xFF91A0B2);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final manager = DownloadManager(storage: AppStorage());
  await manager.init();
  runApp(ArusApp(manager: manager));
}

class ArusApp extends StatelessWidget {
  const ArusApp({super.key, required this.manager});

  final DownloadManager manager;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
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
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        ),
        dialogTheme: const DialogThemeData(
          backgroundColor: _panel,
          surfaceTintColor: Colors.transparent,
        ),
      ),
      home: ArusShell(manager: manager),
    );
  }
}

enum _Page { downloads, settings }

enum _Filter { all, downloading, completed, paused, failed, trash }

extension on _Filter {
  String get label {
    switch (this) {
      case _Filter.all:
        return 'Semua';
      case _Filter.downloading:
        return 'Mengunduh';
      case _Filter.completed:
        return 'Selesai';
      case _Filter.paused:
        return 'Dijeda';
      case _Filter.failed:
        return 'Gagal';
      case _Filter.trash:
        return 'Sampah';
    }
  }

  bool matches(DownloadTask task) {
    switch (this) {
      case _Filter.all:
        return true;
      case _Filter.downloading:
        return task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued;
      case _Filter.completed:
        return task.status == DownloadStatus.completed;
      case _Filter.paused:
        return task.status == DownloadStatus.paused;
      case _Filter.failed:
        return task.status == DownloadStatus.failed;
      case _Filter.trash:
        return task.status == DownloadStatus.cancelled;
    }
  }
}

class ArusShell extends StatefulWidget {
  const ArusShell({super.key, required this.manager});

  final DownloadManager manager;

  @override
  State<ArusShell> createState() => _ArusShellState();
}

class _ArusShellState extends State<ArusShell> {
  _Page _page = _Page.downloads;
  _Filter _filter = _Filter.all;
  final Set<String> _selected = <String>{};
  final Set<String> _expanded = <String>{};

  DownloadManager get manager => widget.manager;

  @override
  void initState() {
    super.initState();
    manager.addListener(_cleanSelection);
  }

  @override
  void dispose() {
    manager.removeListener(_cleanSelection);
    super.dispose();
  }

  void _cleanSelection() {
    final ids = manager.tasks.map((task) => task.id).toSet();
    final stale = _selected.where((id) => !ids.contains(id)).toList();
    if (stale.isEmpty || !mounted) {
      return;
    }
    setState(() => _selected.removeAll(stale));
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
        return Scaffold(
          body: SafeArea(
            child: Row(
              children: <Widget>[
                _Sidebar(
                  page: _page,
                  onSelect: (page) => setState(() => _page = page),
                ),
                Expanded(
                  child: Column(
                    children: <Widget>[
                      _TopBar(
                        onAdd: _showAddDialog,
                        onSettings: () => setState(() => _page = _Page.settings),
                      ),
                      Expanded(
                        child: _page == _Page.downloads
                            ? _buildDownloads(tasks)
                            : _SettingsView(
                                manager: manager,
                                onBack: () => setState(() => _page = _Page.downloads),
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
    final active = tasks.where((task) => task.status == DownloadStatus.downloading).toList();
    final queued = tasks.where((task) => task.status == DownloadStatus.queued).length;
    final totalSpeed = active.fold<int>(0, (sum, task) => sum + task.speedBytesPerSecond);
    final selectedVisible = visible.where((task) => _selected.contains(task.id)).toList();
    final allVisibleSelected = visible.isNotEmpty && visible.every((task) => _selected.contains(task.id));
    final counts = <_Filter, int>{
      for (final filter in _Filter.values) filter: tasks.where(filter.matches).length,
    };

    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(28, 18, 28, 32),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: math.max(0, constraints.maxHeight - 50)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                _SpeedHero(
                  active: active.length,
                  queued: queued,
                  speed: totalSpeed,
                  peak: tasks.fold<int>(
                    0,
                    (maxSpeed, task) => math.max(maxSpeed, task.speedBytesPerSecond),
                  ),
                  onAdd: _showAddDialog,
                  onSettings: () => setState(() => _page = _Page.settings),
                ),
                const SizedBox(height: 18),
                _ActionBar(
                  selectedCount: selectedVisible.length,
                  allSelected: allVisibleSelected,
                  canPause: selectedVisible.any(
                    (task) => task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued,
                  ),
                  canResume: selectedVisible.any(
                    (task) => task.status == DownloadStatus.paused ||
                        task.status == DownloadStatus.failed ||
                        task.status == DownloadStatus.cancelled,
                  ),
                  hasActive: active.isNotEmpty || queued > 0,
                  hasCompleted: tasks.any((task) => task.status == DownloadStatus.completed),
                  onToggleAll: () {
                    setState(() {
                      if (allVisibleSelected) {
                        _selected.removeAll(visible.map((task) => task.id));
                      } else {
                        _selected.addAll(visible.map((task) => task.id));
                      }
                    });
                  },
                  onPause: () => _run(() => manager.pauseMany(selectedVisible.map((task) => task.id))),
                  onResume: () => _run(() => manager.resumeMany(selectedVisible.map((task) => task.id))),
                  onPauseAll: () => _run(manager.pauseAll),
                  onRemove: () => _run(() async {
                    for (final task in selectedVisible) {
                      await manager.remove(task.id);
                    }
                    if (mounted) {
                      setState(() => _selected.clear());
                    }
                  }),
                  onRemoveCompleted: () => _run(manager.removeCompleted),
                ),
                const SizedBox(height: 14),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    for (final filter in _Filter.values)
                      ChoiceChip(
                        label: Text('${filter.label}  ${counts[filter]}'),
                        selected: _filter == filter,
                        onSelected: (_) => setState(() => _filter = filter),
                        selectedColor: _primary.withValues(alpha: 0.18),
                        side: BorderSide(color: _filter == filter ? _primary : _border),
                        labelStyle: TextStyle(
                          color: _filter == filter ? _primary : _muted,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                        showCheckmark: false,
                      ),
                  ],
                ),
                const SizedBox(height: 14),
                if (visible.isEmpty)
                  const _EmptyState()
                else
                  for (final task in visible)
                    _DownloadCard(
                      task: task,
                      expanded: _expanded.contains(task.id),
                      selected: _selected.contains(task.id),
                      onToggleExpanded: () {
                        setState(() {
                          if (!_expanded.add(task.id)) {
                            _expanded.remove(task.id);
                          }
                        });
                      },
                      onSelected: (value) {
                        setState(() {
                          if (value) {
                            _selected.add(task.id);
                          } else {
                            _selected.remove(task.id);
                          }
                        });
                      },
                      onPause: () => _run(() => manager.pause(task.id)),
                      onResume: () => _run(() => manager.resume(task.id)),
                      onCancel: () => _run(() => manager.cancel(task.id)),
                      onRemove: () => _run(() async {
                        await manager.remove(task.id);
                        if (mounted) {
                          setState(() => _selected.remove(task.id));
                        }
                      }),
                      onReveal: () => _run(() => manager.revealInFolder(task.id)),
                    ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.page, required this.onSelect});

  final _Page page;
  final ValueChanged<_Page> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 92,
      color: _panel,
      child: Column(
        children: <Widget>[
          const SizedBox(height: 20),
          Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: _primary.withValues(alpha: 0.16),
              borderRadius: BorderRadius.circular(13),
              border: Border.all(color: _primary.withValues(alpha: 0.38)),
            ),
            child: const Icon(Icons.bolt_rounded, color: _primary, size: 24),
          ),
          const SizedBox(height: 28),
          _NavButton(
            icon: Icons.download_rounded,
            label: 'Unduhan',
            selected: page == _Page.downloads,
            onPressed: () => onSelect(_Page.downloads),
          ),
          _NavButton(
            icon: Icons.tune_rounded,
            label: 'Pengaturan',
            selected: page == _Page.settings,
            onPressed: () => onSelect(_Page.settings),
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.only(bottom: 18),
            child: Text(
              'ARUS',
              style: TextStyle(
                color: _muted.withValues(alpha: 0.65),
                fontSize: 10,
                letterSpacing: 2.2,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
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
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Tooltip(
        message: label,
        child: IconButton(
          onPressed: onPressed,
          style: IconButton.styleFrom(
            backgroundColor: selected ? _primary.withValues(alpha: 0.16) : Colors.transparent,
            foregroundColor: selected ? _primary : _muted,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            fixedSize: const Size(68, 50),
          ),
          icon: Icon(icon, size: 22),
        ),
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.onAdd, required this.onSettings});

  final VoidCallback onAdd;
  final VoidCallback onSettings;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 64,
      padding: const EdgeInsets.symmetric(horizontal: 28),
      decoration: const BoxDecoration(
        color: _background,
        border: Border(bottom: BorderSide(color: _border)),
      ),
      child: Row(
        children: <Widget>[
          const Text(
            'Arus',
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, letterSpacing: 0.2),
          ),
          const SizedBox(width: 10),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: _secondary.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(6),
            ),
            child: const Text(
              'DOWNLOAD MANAGER',
              style: TextStyle(color: _secondary, fontSize: 9, letterSpacing: 1.1, fontWeight: FontWeight.w700),
            ),
          ),
          const Spacer(),
          IconButton(
            onPressed: onSettings,
            tooltip: 'Pengaturan',
            icon: const Icon(Icons.settings_outlined, color: _muted, size: 20),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            onPressed: onAdd,
            icon: const Icon(Icons.add_rounded, size: 18),
            label: const Text('Unduhan baru'),
            style: FilledButton.styleFrom(
              backgroundColor: _primary,
              foregroundColor: _background,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            ),
          ),
        ],
      ),
    );
  }
}

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
              crossAxisAlignment: compact ? CrossAxisAlignment.stretch : CrossAxisAlignment.center,
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
                            style: TextStyle(color: _muted, fontSize: 11, letterSpacing: 1.3, fontWeight: FontWeight.w700),
                          ),
                          const Spacer(),
                          IconButton(
                            onPressed: onSettings,
                            tooltip: 'Koneksi paralel',
                            icon: const Icon(Icons.tune_rounded, color: _muted, size: 18),
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
                          _StatPill(label: 'Aktif', value: '$active', accent: _secondary),
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
          Text(value, style: TextStyle(color: accent ?? _text, fontSize: 12, fontWeight: FontWeight.w700)),
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
              Icon(Icons.speed_rounded, color: speed > 0 ? _secondary : _muted, size: 22),
              const SizedBox(height: 4),
              Text(speed > 0 ? 'AKTIF' : 'SIAP', style: const TextStyle(color: _muted, fontSize: 10, letterSpacing: 1.2)),
            ],
          ),
        ],
      ),
    );
  }
}

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
          _ToolbarButton(icon: Icons.pause_rounded, label: 'Jeda', onPressed: onPause),
        if (selectedCount > 0 && canResume)
          _ToolbarButton(icon: Icons.play_arrow_rounded, label: 'Lanjut', onPressed: onResume),
        if (selectedCount > 0)
          _ToolbarButton(icon: Icons.delete_outline_rounded, label: 'Hapus', onPressed: onRemove, danger: true),
        if (selectedCount == 0 && hasActive)
          _ToolbarButton(icon: Icons.pause_circle_outline_rounded, label: 'Jeda semua', onPressed: onPauseAll),
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
          side: BorderSide(color: danger ? _error.withValues(alpha: 0.5) : _border),
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
            Icon(Icons.download_for_offline_outlined, color: _muted.withValues(alpha: 0.55), size: 42),
            const SizedBox(height: 14),
            const Text('Belum ada unduhan di sini.', style: TextStyle(color: _muted, fontSize: 13)),
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
    required this.selected,
    required this.onToggleExpanded,
    required this.onSelected,
    required this.onPause,
    required this.onResume,
    required this.onCancel,
    required this.onRemove,
    required this.onReveal,
  });

  final DownloadTask task;
  final bool expanded;
  final bool selected;
  final VoidCallback onToggleExpanded;
  final ValueChanged<bool> onSelected;
  final VoidCallback onPause;
  final VoidCallback onResume;
  final VoidCallback onCancel;
  final VoidCallback onRemove;
  final VoidCallback onReveal;

  @override
  Widget build(BuildContext context) {
    final active = task.status == DownloadStatus.downloading;
    final canPause = task.status == DownloadStatus.downloading || task.status == DownloadStatus.queued;
    final canResume = task.status == DownloadStatus.paused ||
        task.status == DownloadStatus.failed ||
        task.status == DownloadStatus.cancelled;
    final canCancel = task.status == DownloadStatus.downloading ||
        task.status == DownloadStatus.queued ||
        task.status == DownloadStatus.paused;
    final canRemove = task.status == DownloadStatus.completed ||
        task.status == DownloadStatus.failed ||
        task.status == DownloadStatus.cancelled ||
        task.status == DownloadStatus.paused;

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Column(
        children: <Widget>[
          InkWell(
            onTap: onToggleExpanded,
            borderRadius: expanded
                ? const BorderRadius.vertical(top: Radius.circular(12))
                : BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 12, 10, 12),
              child: Row(
                children: <Widget>[
                  Checkbox(
                    value: selected,
                    onChanged: (value) => onSelected(value ?? false),
                    activeColor: _primary,
                    checkColor: _background,
                  ),
                  _ProgressRing(task: task, active: active),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          task.fileName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: task.status == DownloadStatus.cancelled ? _muted : _text,
                            fontWeight: FontWeight.w600,
                            fontSize: 13,
                          ),
                        ),
                        const SizedBox(height: 5),
                        Text(
                          _taskMeta(task),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: _muted, fontSize: 11, fontFamily: 'monospace'),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  _StatusChip(status: task.status),
                  const SizedBox(width: 8),
                  _SmallIconButton(
                    icon: canPause
                        ? Icons.pause_rounded
                        : (canResume ? Icons.play_arrow_rounded : Icons.folder_outlined),
                    tooltip: canPause ? 'Jeda' : (canResume ? 'Lanjut' : 'Tampilkan di folder'),
                    color: canPause ? _muted : (canResume ? _secondary : _muted),
                    onPressed: canPause ? onPause : (canResume ? onResume : onReveal),
                  ),
                  _SmallIconButton(
                    icon: canCancel
                        ? Icons.stop_rounded
                        : (canRemove ? Icons.delete_outline_rounded : Icons.folder_open_outlined),
                    tooltip: canCancel ? 'Stop' : (canRemove ? 'Hapus' : 'Tampilkan di folder'),
                    color: canCancel ? _error : _muted,
                    onPressed: canCancel ? onCancel : (canRemove ? onRemove : onReveal),
                  ),
                  _SmallIconButton(
                    icon: expanded ? Icons.keyboard_arrow_up_rounded : Icons.keyboard_arrow_down_rounded,
                    tooltip: expanded ? 'Sembunyikan detail' : 'Tampilkan detail',
                    color: _muted,
                    onPressed: onToggleExpanded,
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
  final speed = task.speedBytesPerSecond > 0 ? ' · ${formatSpeed(task.speedBytesPerSecond)}' : '';
  final connections = task.segments == null || task.segments!.isEmpty ? 1 : task.segments!.length;
  return '${task.progress.toStringAsFixed(1)}% · ${formatBytes(task.bytesReceived)} / $total · $connections koneksi$speed';
}

class _ProgressRing extends StatelessWidget {
  const _ProgressRing({required this.task, required this.active});

  final DownloadTask task;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final color = switch (task.status) {
      DownloadStatus.completed => _success,
      DownloadStatus.failed => _error,
      DownloadStatus.downloading || DownloadStatus.queued => _secondary,
      _ => _muted,
    };
    return SizedBox(
      width: 42,
      height: 42,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          CircularProgressIndicator(
            value: task.status == DownloadStatus.completed ? 1 : (task.progress / 100).clamp(0, 1),
            strokeWidth: 3,
            color: color,
            backgroundColor: _border,
          ),
          if (task.status == DownloadStatus.completed)
            const Icon(Icons.check_rounded, color: _success, size: 17)
          else
            Text(
              '${task.progress.round()}',
              style: TextStyle(color: active ? _secondary : _muted, fontSize: 10, fontWeight: FontWeight.w700),
            ),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final DownloadStatus status;

  @override
  Widget build(BuildContext context) {
    final color = switch (status) {
      DownloadStatus.completed => _success,
      DownloadStatus.failed => _error,
      DownloadStatus.downloading || DownloadStatus.queued => _secondary,
      _ => _muted,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.11),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        status.label,
        style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.w700),
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
      padding: const EdgeInsets.fromLTRB(68, 4, 20, 18),
      decoration: const BoxDecoration(
        color: _background,
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(12)),
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
              style: TextStyle(color: _muted, fontSize: 10, letterSpacing: 1.1, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 8),
            for (final segment in segments) _SegmentLine(segment: segment),
          ],
          if (task.error != null) ...<Widget>[
            const SizedBox(height: 12),
            Text(task.error!, style: const TextStyle(color: _error, fontSize: 11)),
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
        SizedBox(width: 68, child: Text(label, style: const TextStyle(color: _muted, fontSize: 10))),
        Expanded(
          child: SelectableText(
            value,
            maxLines: 2,
            style: const TextStyle(color: _text, fontSize: 11, fontFamily: 'monospace'),
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
          SizedBox(width: 28, child: Text('#${segment.index + 1}', style: const TextStyle(color: _muted, fontSize: 10))),
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
              style: const TextStyle(color: _muted, fontSize: 10, fontFamily: 'monospace'),
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

  Future<void> _update(Future<void> Function() action, BuildContext context) async {
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
            IconButton(onPressed: onBack, icon: const Icon(Icons.arrow_back_rounded, color: _muted)),
            const SizedBox(width: 6),
            const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Preferensi Arus', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
                SizedBox(height: 4),
                Text('Atur performa unduhan dan perilaku aplikasi.', style: TextStyle(color: _muted, fontSize: 12)),
              ],
            ),
          ],
        ),
        const SizedBox(height: 24),
        _SettingsSection(
          title: 'Performa unduhan',
          subtitle: 'Gunakan koneksi paralel untuk server yang mendukung Range.',
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
                () => manager.updateSettings(maxConcurrentDownloads: value.round()),
                context,
              ),
            ),
            _SliderSetting(
              title: 'Percobaan ulang',
              description: 'Retry saat koneksi putus atau server mengembalikan error sementara.',
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
              onChanged: (value) => _update(() => manager.updateSettings(revealOnComplete: value), context),
            ),
            _SwitchSetting(
              title: 'Jalankan saat login',
              description: 'Siapkan Arus ketika Windows mulai.',
              value: settings.launchAtLogin,
              onChanged: (value) => _update(() => manager.updateSettings(launchAtLogin: value), context),
            ),
          ],
        ),
        const SizedBox(height: 14),
        _SettingsSection(
          title: 'Integrasi browser',
          subtitle: 'Ekstensi lama tetap tersedia selama bridge Native Messaging dipindahkan.',
          children: <Widget>[
            _SwitchSetting(
              title: 'Terima unduhan dari browser',
              description: 'Status tersimpan di Flutter; bridge lama masih ada di extension-legacy-http/.',
              value: settings.browserIntegrationEnabled,
              onChanged: (value) => _update(
                () => manager.updateSettings(browserIntegrationEnabled: value),
                context,
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
                      'Unduhan manual dan pemulihan file .part sudah berjalan penuh di Flutter. Integrasi browser memakai adapter Native Messaging pada tahap berikutnya.',
                      style: TextStyle(color: _muted, fontSize: 11, height: 1.45),
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
          subtitle: 'Folder baru dibuat otomatis sebelum probe dan setiap retry.',
          children: <Widget>[
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.folder_outlined, color: _secondary),
              title: const Text('Folder unduhan default', style: TextStyle(fontSize: 13)),
              subtitle: Text(manager.defaultDirectory, style: const TextStyle(color: _muted, fontSize: 11)),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.save_outlined, color: _secondary),
              title: const Text('Resume metadata', style: TextStyle(fontSize: 13)),
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
  const _SettingsSection({required this.title, required this.subtitle, required this.children});

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
            Text(title, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(subtitle, style: const TextStyle(color: _muted, fontSize: 11, height: 1.4)),
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
                    Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 3),
                    Text(description, style: const TextStyle(color: _muted, fontSize: 11)),
                  ],
                ),
              ),
              Text(valueLabel, style: const TextStyle(color: _primary, fontSize: 12, fontWeight: FontWeight.w700)),
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
      title: Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      subtitle: Text(description, style: const TextStyle(color: _muted, fontSize: 11, height: 1.35)),
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
    _directoryController = TextEditingController(text: widget.manager.defaultDirectory);
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
        fileName: _fileController.text.trim().isEmpty ? null : _fileController.text,
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
                  if (uri == null || (uri.scheme != 'http' && uri.scheme != 'https') || uri.host.isEmpty) {
                    return 'Masukkan URL HTTP atau HTTPS yang valid';
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
                Text(_formError!, style: const TextStyle(color: _error, fontSize: 11)),
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
              ? const SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.download_rounded, size: 17),
          label: const Text('Mulai unduh'),
          style: FilledButton.styleFrom(backgroundColor: _primary, foregroundColor: _background),
        ),
      ],
    );
  }
}
