import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:arus_flutter/main.dart';
import 'package:arus_flutter/src/services/app_storage.dart';
import 'package:arus_flutter/src/services/download_manager.dart';

void main() {
  testWidgets('Arus dashboard renders without an initialized queue', (
    tester,
  ) async {
    final root = Directory(
      '${Directory.systemTemp.path}${Platform.pathSeparator}arus-flutter-widget-test',
    );
    final manager = DownloadManager(storage: AppStorage(root: root));

    await tester.pumpWidget(ArusApp(manager: manager));

    expect(find.text('Arus'), findsOneWidget);
    expect(find.text('Add download'), findsOneWidget);
    expect(find.text('Belum ada unduhan di sini.'), findsOneWidget);
  });
}
