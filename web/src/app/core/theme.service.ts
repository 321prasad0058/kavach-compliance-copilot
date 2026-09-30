import { Injectable, signal } from '@angular/core';

export type ThemeId = 'midnight' | 'obsidian' | 'daylight';

export interface ThemeOption {
  id: ThemeId;
  label: string;
  glow: string;
}

const KEY = 'kavach_theme_v1';

/** Three VANA-style modes; Midnight is the CJP credit-score palette. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly options: ThemeOption[] = [
    { id: 'midnight', label: 'Midnight', glow: '#43CEFF' },
    { id: 'obsidian', label: 'Obsidian', glow: '#8B5CF6' },
    { id: 'daylight', label: 'Daylight', glow: '#F5A524' },
  ];

  readonly theme = signal<ThemeId>(this.initial());

  set(id: ThemeId): void {
    this.theme.set(id);
    document.documentElement.setAttribute('data-theme', id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* private mode: theme still applies for this session */
    }
  }

  private initial(): ThemeId {
    const attr = document.documentElement.getAttribute('data-theme') as ThemeId | null;
    return attr && ['midnight', 'obsidian', 'daylight'].includes(attr) ? attr : 'midnight';
  }
}
