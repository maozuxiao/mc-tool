import { Component, ReactNode } from 'react'

export class ErrorBoundary extends Component<{ children: ReactNode }, { err: string }> {
  state = { err: '' }
  static getDerivedStateFromError(error: any) {
    return { err: String(error && error.stack ? error.stack : error) }
  }
  componentDidCatch(error: any, info: any) {
    const msg = `[RENDER-CRASH] ${String(error && error.stack ? error.stack : error)}\n${info && info.componentStack ? info.componentStack : ''}`
    // 落盘到主进程日志
    try {
      const fs = (window as any).mcApi
      if (fs && fs.logError) fs.logError(msg)
    } catch {}
    console.error(msg)
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 20, color: '#c00', fontFamily: 'monospace', whiteSpace: 'pre-wrap', fontSize: 12 }}>
          <h3>渲染异常（已被捕获，未白屏）</h3>
          <pre>{this.state.err}</pre>
          <button onClick={() => this.setState({ err: '' })}>重试</button>
        </div>
      )
    }
    return this.props.children
  }
}
