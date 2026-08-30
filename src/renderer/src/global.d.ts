// mcApi 的全局类型直接由 preload 的实现推导，避免手写声明与实现不同步。
// 之前 App.tsx 里手写的 declare global 漏了 getZoom/setZoom/resetZoom/openExternal/
// refreshOaSession/downloadFile，且 startQrLogin、pollQrLogin 签名写错，
// 覆盖真实类型后在 QueryPanel / store / LoginOverlay 产生一批「属性不存在」误报。
import type { McApi } from '../../preload/index'

declare global {
  interface Window {
    mcApi: McApi
  }
}
