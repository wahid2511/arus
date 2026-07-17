export {
  NATIVE_HOST_NAME,
  CHROME_EXTENSION_ID,
  FIREFOX_EXTENSION_ID,
  type BridgeRequest,
  type BridgeResponse
} from '../../shared/nativeProtocol'

export const PIPE_NAME =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\com.arus.app.bridge.v2'
    : '/tmp/com.arus.app.bridge.v2.sock'
