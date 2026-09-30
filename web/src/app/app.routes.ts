import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/copilot/copilot').then((m) => m.CopilotPage), title: 'Kavach · Copilot' },
  { path: 'alerts', loadComponent: () => import('./pages/alerts/alerts').then((m) => m.AlertsPage), title: 'Kavach · Live alerts' },
  { path: 'findings', loadComponent: () => import('./pages/findings/findings').then((m) => m.FindingsPage), title: 'Kavach · Findings' },
  { path: 'audit', loadComponent: () => import('./pages/audit/audit').then((m) => m.AuditPage), title: 'Kavach · Audit log' },
  { path: '**', redirectTo: '' },
];
