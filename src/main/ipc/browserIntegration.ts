import type { BrowserIntegrationStatus } from '../../shared/downloadTypes'
import {
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  NATIVE_HOST_NAME
} from '../../shared/nativeProtocol'
import { appState } from '../app/state'
import { isLoginItemSupported } from '../system/loginItem'
import {
  installNativeMessagingHost,
  resolveExtensionDistPath
} from '../nativeMessaging/register'

export function getBrowserIntegrationStatus(): BrowserIntegrationStatus {
  return {
    enabled: appState.downloads!.getSettings().browserIntegrationEnabled,
    bridgeListening: appState.nativeBridge!.isListening(),
    hostInstalled: Boolean(appState.lastHostInstall?.ok),
    hostName: NATIVE_HOST_NAME,
    chromeExtensionId: appState.lastHostInstall?.chromeExtensionId || CHROME_EXTENSION_ID,
    firefoxExtensionId: FIREFOX_EXTENSION_ID,
    extensionPath: resolveExtensionDistPath(),
    loginItemSupported: isLoginItemSupported(),
    lastError: appState.lastHostInstall?.error
  }
}

export function registerHost(): BrowserIntegrationStatus {
  appState.lastHostInstall = installNativeMessagingHost()
  return getBrowserIntegrationStatus()
}
