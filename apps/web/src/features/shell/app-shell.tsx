'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Bell,
  Check,
  FileText,
  ChevronsUpDown,
  FolderKanban,
  ListTodo,
  LayoutDashboard,
  Layers,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  CalendarDays,
  Mail,
  Plug,
  Plus,
  ClipboardCheck,
  Mic,
  ShieldAlert,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react';
import type { Permission } from '@teamos/permissions';
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@teamos/ui';
import { useLogout, useMe } from '@/lib/session';
import { useUi } from '@/lib/ui-store';
import { ROLE_LABEL } from '@/lib/labels';
import { useOrgContext } from '@/features/org/org-context';
import { NotificationBell } from '@/features/notifications/bell';
import { useRealtime } from '@/features/notifications/realtime';

interface NavItem {
  label: string;
  href: (orgId: string) => string;
  icon: typeof LayoutDashboard;
  permission?: Permission;
}

const NAV: NavItem[] = [
  { label: 'Dashboard', href: (o) => `/o/${o}/dashboard`, icon: LayoutDashboard },
  { label: 'Projects', href: (o) => `/o/${o}/projects`, icon: FolderKanban, permission: 'project:read' },
  { label: 'My tasks', href: (o) => `/o/${o}/my-tasks`, icon: ListTodo, permission: 'task:read' },
  { label: 'Documents', href: (o) => `/o/${o}/documents`, icon: FileText, permission: 'document:read' },
  { label: 'Meetings', href: (o) => `/o/${o}/meetings`, icon: Mic, permission: 'document:read' },
  { label: 'Risk center', href: (o) => `/o/${o}/risks`, icon: ShieldAlert, permission: 'project:read' },
  { label: 'Approvals', href: (o) => `/o/${o}/approvals`, icon: ClipboardCheck, permission: 'approval:read' },
  { label: 'Calendar', href: (o) => `/o/${o}/calendar`, icon: CalendarDays, permission: 'project:read' },
  { label: 'Email', href: (o) => `/o/${o}/emails`, icon: Mail, permission: 'document:read' },
  { label: 'Integrations', href: (o) => `/o/${o}/integrations`, icon: Plug, permission: 'project:read' },
  { label: 'Knowledge search', href: (o) => `/o/${o}/knowledge`, icon: Search, permission: 'document:read' },
  { label: 'Notifications', href: (o) => `/o/${o}/notifications`, icon: Bell },
  { label: 'Workspaces', href: (o) => `/o/${o}/workspaces`, icon: Layers, permission: 'workspace:read' },
  { label: 'Team members', href: (o) => `/o/${o}/members`, icon: Users, permission: 'member:read' },
  { label: 'Roles & permissions', href: (o) => `/o/${o}/roles`, icon: ShieldCheck, permission: 'member:read' },
  { label: 'Audit logs', href: (o) => `/o/${o}/audit-logs`, icon: ScrollText, permission: 'audit:read' },
  { label: 'Organization settings', href: (o) => `/o/${o}/settings`, icon: Settings, permission: 'org:update' },
];

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { orgId, orgName, can } = useOrgContext();
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const memberships = me.data?.memberships ?? [];

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn('flex items-center gap-2 px-4 pb-3 pt-4', collapsed && 'justify-center px-2')}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        {!collapsed ? <span className="text-base font-semibold text-foreground">TeamOS AI</span> : null}
      </div>

      <div className={cn('px-3 pb-3', collapsed && 'px-2')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Switch organization"
              className={cn(
                'flex w-full items-center gap-2 rounded-xl border border-border bg-card p-2 text-left text-sm shadow-card transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                collapsed && 'justify-center',
              )}
            >
              <Avatar name={orgName} size="sm" />
              {!collapsed ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{orgName}</span>
                    <span className="block text-xs text-muted-foreground">Organization</span>
                  </span>
                  <ChevronsUpDown className="h-4 w-4 text-muted-foreground" aria-hidden />
                </>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Your organizations</DropdownMenuLabel>
            {memberships.map((m) => (
              <DropdownMenuItem
                key={m.organizationId}
                onSelect={() => router.push(`/o/${m.organizationId}/dashboard`)}
              >
                <Avatar name={m.organizationName} size="sm" />
                <span className="flex-1 truncate">{m.organizationName}</span>
                {m.organizationId === orgId ? <Check className="h-4 w-4 text-primary" aria-hidden /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push('/onboarding/organization')}>
              <Plus className="h-4 w-4" aria-hidden /> Create organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto px-3">
        {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => {
          const href = n.href(orgId);
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={n.label}
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? n.label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-muted',
                active && 'bg-sidebar-accent text-primary hover:bg-sidebar-accent',
                collapsed && 'justify-center px-2',
              )}
            >
              <n.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
              {!collapsed ? <span className="truncate">{n.label}</span> : <span className="sr-only">{n.label}</span>}
            </Link>
          );
        })}
      </nav>

      {!collapsed ? (
        <div className="m-3 rounded-xl bg-primary-soft p-3 text-xs text-primary">
          <p className="font-semibold">More AI is on the way</p>
          <p className="mt-1 text-primary/80">
            Search, meetings, planning, risk detection, approvals, GitHub, Google Calendar and Gmail are live.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </Button>
  );
}

function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const { role } = useOrgContext();
  const user = me.data?.user;
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label="Account menu" className="flex items-center gap-2 rounded-full focus-visible:ring-2 focus-visible:ring-ring">
          <Avatar name={user.name} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-2">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <Badge tone="primary" className="mt-2">
            {ROLE_LABEL[role]}
          </Badge>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => logout.mutate()}>
          <LogOut className="h-4 w-4" aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AssistantPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-label="AI assistant"
      className="hidden w-80 shrink-0 flex-col border-l border-border bg-card xl:flex"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden /> AI Assistant
        </div>
        <Button variant="ghost" size="icon" aria-label="Close assistant" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="rounded-full bg-primary-soft p-3 text-primary">
          <Sparkles className="h-6 w-6" aria-hidden />
        </div>
        <Badge tone="warning">Not available yet</Badge>
        <p className="text-sm text-muted-foreground">
          The context-aware assistant (project planning, risk analysis, meeting intelligence) is built in the AI
          phases. It will only propose changes — you approve every one.
        </p>
      </div>
    </aside>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { orgId } = useOrgContext();
  useRealtime(orgId);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  const assistantOpen = useUi((s) => s.assistantOpen);
  const toggleAssistant = useUi((s) => s.toggleAssistant);
  const [mobileOpen, setMobileOpen] = useState(false);
  const router = useRouter();
  const { can } = useOrgContext();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>

      <div className={cn('hidden shrink-0 border-r border-border transition-[width] lg:block', collapsed ? 'w-[72px]' : 'w-64')}>
        <Sidebar collapsed={collapsed} />
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-border shadow-pop">
            <Sidebar collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggle}
          >
            {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          </Button>

          {can('document:read') ? (
            <form
              role="search"
              className="relative ml-1 hidden w-full max-w-md md:block"
              onSubmit={(e) => {
                e.preventDefault();
                const q = new FormData(e.currentTarget).get('q');
                if (typeof q === 'string' && q.trim().length >= 3) router.push(`/o/${orgId}/knowledge?q=${encodeURIComponent(q.trim())}`);
              }}
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                name="q"
                aria-label="Search knowledge"
                placeholder="Search documents and knowledge…"
                maxLength={500}
                className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </form>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={assistantOpen ? 'secondary' : 'ghost'}
              size="icon"
              aria-label="Toggle AI assistant"
              aria-pressed={assistantOpen}
              onClick={toggleAssistant}
              className="hidden xl:inline-flex"
            >
              <Sparkles className="h-[18px] w-[18px]" />
            </Button>
            <NotificationBell />
            <ThemeToggle />
            <div className="ml-1">
              <UserMenu />
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
          {assistantOpen ? <AssistantPanel onClose={toggleAssistant} /> : null}
        </div>
      </div>
    </div>
  );
}
