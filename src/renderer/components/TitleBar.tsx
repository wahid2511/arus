import type { ReactElement } from 'react'
import { IconMinus, IconSquare, IconX } from './Icons'
import appIcon from '../assets/icon.png'

export interface TitleBarProps {
  title?: string
  onMinimize?: () => void
  onMaximize?: () => void
  onClose?: () => void
}

export default function TitleBar({
  title = 'Arus',
  onMinimize,
  onMaximize,
  onClose
}: TitleBarProps): ReactElement {
  return (
    <header className="title-bar">
      <div className="title-bar__brand">
        <img className="title-bar__logo" src={appIcon} width={20} height={20} alt="" aria-hidden="true" />
        <span className="title-bar__name">{title}</span>
      </div>

      <div className="title-bar__controls">
        <button type="button" className="title-bar__btn" aria-label="Minimize" onClick={onMinimize}>
          <IconMinus size={13} />
        </button>
        <button type="button" className="title-bar__btn" aria-label="Maximize" onClick={onMaximize}>
          <IconSquare size={12} />
        </button>
        <button type="button" className="title-bar__btn title-bar__btn--close" aria-label="Close" onClick={onClose}>
          <IconX size={13} />
        </button>
      </div>
    </header>
  )
}
