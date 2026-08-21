import { useState } from 'react'
import { useStore } from '../store'
import { extractFileLink, escapeHtml } from '@shared/query'
import { OA_ORIGIN } from '@shared/constants'

export function FileTable() {
  const t = useStore(s => s.t)
  const fileData = useStore(s => s.fileData)
  const [downloading, setDownloading] = useState<string | null>(null)

  if (!fileData.length) {
    return <div className="empty-box" dangerouslySetInnerHTML={{ __html: t('emptyFile') }} />
  }

  const rows = fileData

  const handleDownload = async (url: string, text: string, key: string) => {
    setDownloading(key)
    try {
      const res: any = await (window as any).mcApi?.downloadFile
        ? await (window as any).mcApi.downloadFile({ url, filename: text })
        : { ok: false, error: 'no ipc' }
      if (!res?.ok) {
        if (res?.error === 'NEED_RELOGIN') {
          alert(t('fileNeedLogin'))
        } else if (!res?.canceled) {
          alert(t('fileDownloadFail', { m: res?.error || 'unknown' }))
        }
      }
    } catch (e: any) {
      alert(t('fileDownloadFail', { m: e?.message || String(e) }))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div>
      <div className="count-line">
        <span>{t('countFile', { n: rows.length })}</span>
      </div>
      <div className="table-wrap">
        <table className="mq">
          <thead>
            <tr>
              <th className="td-num" style={{ width: 40 }}>#</th>
              <th className="td-item" style={{ width: 160 }}>{t('thItemNo')}</th>
              <th style={{ width: 280 }}>{t('thDesc')}</th>
              <th style={{ width: 240 }}>{t('thFile')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const itemNo = String(r.ITEM_NUMBER || r.itemNumber || '')
              const desc = String(r.ITEM_DESC || r.itemDes || '')
              const fileField = r.fileName || r.HAS_FILE || ''
              const link = fileField ? extractFileLink(String(fileField), OA_ORIGIN) : null
              const key = itemNo + '_' + i
              const isBusy = downloading === key
              return (
                <tr key={i} className="data-row">
                  <td className="td-num">{i + 1}</td>
                  <td className="td-item">{escapeHtml(itemNo)}</td>
                  <td className="td-desc" title={escapeHtml(desc)}>{escapeHtml(desc)}</td>
                  <td>
                    {link ? (
                      <a
                        href="#"
                        className="file-link"
                        onClick={(e) => { e.preventDefault(); if (!isBusy) handleDownload(link.url, link.text, key) }}
                      >
                        {isBusy ? t('downloading') : link.text}
                      </a>
                    ) : (
                      <span className="no-file">{t('noAttachment')}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
