#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <tlhelp32.h>
#include <vector>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

namespace {

bool IsKnownBrowser(const wchar_t* executable) {
  constexpr const wchar_t* kBrowserExecutables[] = {
      L"chrome.exe",
      L"msedge.exe",
      L"brave.exe",
      L"firefox.exe",
      L"opera.exe",
  };
  for (const wchar_t* candidate : kBrowserExecutables) {
    if (::lstrcmpiW(executable, candidate) == 0) {
      return true;
    }
  }
  return false;
}

bool IsBrowserParentProcess() {
  HANDLE snapshot = ::CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return false;
  }

  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  DWORD parent_id = 0;
  if (::Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == ::GetCurrentProcessId()) {
        parent_id = entry.th32ParentProcessID;
        break;
      }
    } while (::Process32NextW(snapshot, &entry));
  }

  bool is_browser = false;
  if (parent_id != 0 && ::Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == parent_id) {
        is_browser = IsKnownBrowser(entry.szExeFile);
        break;
      }
    } while (::Process32NextW(snapshot, &entry));
  }
  ::CloseHandle(snapshot);
  return is_browser;
}

bool HasNativeHostArgument(const std::vector<std::string>& arguments) {
  for (const std::string& argument : arguments) {
    if (argument == "--native-host") {
      return true;
    }
  }
  return false;
}

}  // namespace

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  // Chrome and Firefox start a Native Messaging host with stdin/stdout wired
  // to pipes. The same release executable can therefore act as the tiny host
  // helper without shipping a second binary or exposing a public socket.
  const bool is_native_host =
      HasNativeHostArgument(command_line_arguments) ||
      (::GetFileType(::GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE &&
       IsBrowserParentProcess());
  if (is_native_host) {
    if (!HasNativeHostArgument(command_line_arguments)) {
      command_line_arguments.push_back("--native-host");
    }
  }

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"Arus", origin, size)) {
    return EXIT_FAILURE;
  }
  // The generated runner normally waits for Flutter's first frame before
  // showing the window. Show normal app launches immediately as a fallback so
  // a slow plugin/storage initialization cannot leave arus.exe hidden.
  if (!is_native_host) {
    window.Show();
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
