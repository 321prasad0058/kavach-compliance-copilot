import { Injectable, signal } from '@angular/core';

export interface Persona {
  id: string;
  name: string;
  role: string;
  initials: string;
}

const KEY = 'kavach_persona_v1';

/**
 * Demo personas so maker-checker can be shown with one browser. In Snowpark Container Services
 * the API ignores this and uses the Snowflake-authenticated user instead.
 */
@Injectable({ providedIn: 'root' })
export class PersonaService {
  readonly personas: Persona[] = [
    { id: 'priya.menon', name: 'Priya Menon', role: 'FCU Analyst · Maker', initials: 'PM' },
    { id: 'arjun.rao', name: 'Arjun Rao', role: 'Principal Officer · Checker', initials: 'AR' },
  ];

  readonly current = signal<Persona>(this.initial());

  set(p: Persona): void {
    this.current.set(p);
    try {
      localStorage.setItem(KEY, p.id);
    } catch {
      /* ignore */
    }
  }

  private initial(): Persona {
    let id: string | null = null;
    try {
      id = localStorage.getItem(KEY);
    } catch {
      /* ignore */
    }
    return this.personas.find((p) => p.id === id) ?? this.personas[0];
  }
}
