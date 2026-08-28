# Arus

Arus adalah download manager desktop bergaya IDM yang sekarang dibangun
sepenuhnya dengan Flutter Desktop.

## Fitur

- Unduhan paralel berbasis HTTP Range.
- Fallback otomatis ke single-stream jika server tidak mendukung segmented
  download atau tidak konsisten mengembalikan Range.
- Resume setelah pause, restart, atau koneksi terputus.
- Retry koneksi dan antrean unduhan.
- Batas kecepatan global yang dibagikan semua file dan segmen aktif.
- HTTP, HTTPS, dan FTP pasif dengan resume berbasis `.part`.
- Deteksi link clipboard dengan konfirmasi satu klik.
- File sementara .part dan metadata .part.meta.json.
- File final hanya dibuat setelah seluruh segmen berhasil disusun ulang.
- Metadata dan file sementara dibersihkan setelah unduhan sukses.
- Dashboard gelap bergaya IDM dengan filter, kecepatan, ETA, dan detail
  koneksi.
- Notifikasi Windows, system tray, minimize-to-tray, dan custom `arus://` link.
- Bridge browser Native Messaging terautentikasi melalui loopback.
- Logo aplikasi diambil dari logo lama public/icon.png dan sekarang
  digunakan sebagai asset Flutter di assets/arus_logo.png.

## Menjalankan aplikasi

Persyaratan:

- Flutter 3.44+ dan Dart 3.12+.
- Windows: Visual Studio dengan workload **Desktop development with C++**.
- Windows: aktifkan Developer Mode agar Flutter dapat membuat symlink plugin.

~~~powershell
flutter pub get
flutter analyze
flutter test
flutter run -d windows
~~~

Build rilis Windows:

~~~powershell
flutter build windows --release
~~~

Perintah tersebut menghasilkan bundle aplikasi di
`build/windows/x64/runner/Release`, bukan installer. Untuk membuat file
`setup.exe`, install Inno Setup 6 lalu jalankan:

~~~powershell
.\scripts\build_windows_installer.ps1
~~~

Installer akan dibuat di `artifacts/Arus-Setup-1.0.0.exe` dan memasang Arus
secara per-user di `%LOCALAPPDATA%\Programs\Arus`. Jika bundle release sudah
dibuat sebelumnya, gunakan `-SkipFlutterBuild`.

## Struktur proyek

~~~text
lib/
  main.dart                         # UI Flutter
  src/
    models/                         # Model task, segment, dan settings
    services/                       # Queue, persistence, dan downloader
    core/                           # Utilitas path dan format
assets/
  arus_logo.png                     # Logo Flutter
windows/                            # Runner Flutter Desktop dan ikon native Arus
installer/Arus.iss                  # Template installer Inno Setup
scripts/build_windows_installer.ps1 # Build release + setup.exe
extension/                          # Ekstensi browser aktif
extension-legacy-http/              # Ekstensi HTTP lama, untuk referensi
test/                               # Unit test downloader dan widget
~~~

Implementasi React, Electron, Vite, dan konfigurasi Node aplikasi desktop lama
sudah dihapus dari proyek. Dependensi Node hanya diperlukan jika ingin
membangun ekstensi browser:

~~~powershell
cd extension
npm install
npm run build
~~~

## Perilaku unduhan

1. Arus memeriksa ukuran file dan kemampuan server mengembalikan HTTP Range.
2. Jika memungkinkan, file dibagi menjadi beberapa segmen dan diunduh
   paralel.
3. Semua segmen ditulis ke offset yang benar pada satu file .part.
4. Jika server tidak mendukung Range, Arus memakai single-stream dengan resume.
5. URL `ftp://` memakai passive-mode FTP, `SIZE`, dan `REST` bila server
   mendukungnya.
6. Setelah ukuran dan seluruh rentang tervalidasi, .part diubah nama secara
   atomik menjadi file asli.
7. .part, .part.meta.json, dan file sementara dihapus setelah finalisasi
   berhasil.

Jika koneksi atau server berubah di tengah segmented download, Arus
meninggalkan mode paralel dengan aman dan melanjutkan melalui single-stream
agar unduhan tidak berakhir sebagai task gagal hanya karena Range tidak lagi
tersedia.

## File sementara

Contoh isi folder Downloads saat unduhan masih berjalan:

~~~text
video.mp4.part
video.mp4.part.meta.json
~~~

Kedua file tersebut adalah state pemulihan. Keduanya tidak boleh tersisa
setelah file final berhasil dibuat.

## Ekstensi browser

Folder `extension/` tetap dipertahankan sebagai companion browser terpisah.
Setelah Arus berjalan, buka Pengaturan → **Pasang ulang native host** lalu
reload ekstensi. Folder `extension-legacy-http/` adalah implementasi lama dan
tidak disarankan untuk dimuat sebagai ekstensi utama.

Torrent/magnet belum diaktifkan karena membutuhkan binding native libtorrent;
UI akan menolak protokol tersebut dengan aman sampai provider FFI ditambahkan.

## Lisensi

MIT.
