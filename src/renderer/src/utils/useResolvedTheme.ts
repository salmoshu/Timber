import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { resolveTheme, systemPrefersDark } from './settings'

export function useResolvedTheme() {
  const setting = useStore((state) => state.settings.theme)
  const [, setSystemDark] = useState(systemPrefersDark)
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return resolveTheme(setting)
}
