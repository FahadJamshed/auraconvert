import { useState } from 'react'

const assetBase = `${import.meta.env.BASE_URL}brand/`

export function AudioMark({ className = '' }: { className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${className}`} aria-hidden="true">
      {failed ? <svg width="25" height="25" viewBox="0 0 28 28" fill="none" className="text-primary">
        <path d="M5 12v4m4-8v12m5-16v20m5-17v14m4-10v6" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
      </svg> : <img src={`${assetBase}app-icon.png`} alt="" width={256} height={256} className="size-full object-contain" onError={() => setFailed(true)} />}
    </span>
  )
}

function ThemeLogo({ theme }: { theme: 'light' | 'dark' }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={theme === 'light' ? 'block dark:hidden' : 'hidden dark:block'}>
      {failed ? <span className="inline-flex items-center gap-2 text-xl font-semibold tracking-tight"><AudioMark className="size-10" />AuraConvert</span> :
        <img src={`${assetBase}auraconvert-${theme}.webp`} alt="" width={1000} height={243} className="h-auto w-[164px] object-contain sm:w-[204px]" onError={() => setFailed(true)} />}
    </span>
  )
}

export function Brand() {
  return <a href="#" className="inline-flex min-h-11 shrink-0 items-center rounded-md" aria-label="AuraConvert home"><ThemeLogo theme="light" /><ThemeLogo theme="dark" /></a>
}
