import type { ReactElement, ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 15, children, ...props }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function IconArrowDown({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Icon>
  )
}

export function IconLayoutGrid({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </Icon>
  )
}

export function IconArrowDownCircle({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="m15 13-3 3-3-3" />
    </Icon>
  )
}

export function IconCheck({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M5 12l5 5L20 7" />
    </Icon>
  )
}

export function IconPlayerPause({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </Icon>
  )
}

export function IconAlertTriangle({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </Icon>
  )
}

export function IconTrash({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </Icon>
  )
}

export function IconMinus({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M5 12h14" />
    </Icon>
  )
}

export function IconSquare({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </Icon>
  )
}

export function IconX({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  )
}

export function IconPlus({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  )
}

export function IconPlayerPlay({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconPlayerStop({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function IconChevronDown({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

export function IconSettings({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.998 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  )
}

export function IconFolder({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  )
}

export function IconSelectAll({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M8 4h10a2 2 0 0 1 2 2v10" />
      <rect x="4" y="8" width="12" height="12" rx="2" />
    </Icon>
  )
}

export function IconClearCompleted({ size }: IconProps): ReactElement {
  return (
    <Icon size={size}>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6" />
      <path d="M9 7V5a1 1 0 0 1 1-1h2" />
      <path d="m15 15 5 5" />
      <path d="m20 15-5 5" />
    </Icon>
  )
}
