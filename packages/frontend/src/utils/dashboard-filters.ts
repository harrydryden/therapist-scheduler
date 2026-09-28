import type { AppointmentFilters, DashboardStats } from '../types';

/** The summary tile selected on the scheduling dashboard (null = all). */
export type DashboardTileFilter = 'active' | 'confirmed' | 'post-session' | 'attention' | 'human' | null;

export type DashboardSortBy = NonNullable<AppointmentFilters['sortBy']>;
export type DashboardViewMode = 'flat' | 'grouped';

const PRE_BOOKING = 'pending,contacted,negotiating';

/**
 * What each tile means as a server-side filter. The list used to fetch one
 * 100-row page and filter it in the browser, so paused / red appointments
 * that stopped getting updates fell off that page and out of these tiles.
 */
export const TILE_FILTERS: Record<Exclude<DashboardTileFilter, null>, Partial<AppointmentFilters>> = {
  active: { status: PRE_BOOKING },
  confirmed: { status: 'confirmed' },
  'post-session': { status: 'session_held,feedback_requested,completed' },
  attention: { status: PRE_BOOKING, health: 'red' },
  human: { humanControl: true },
};

export const DASHBOARD_PAGE_SIZE = 50;

export interface DashboardState {
  tile: DashboardTileFilter;
  q: string;
  sortBy: DashboardSortBy;
  sortOrder: 'asc' | 'desc';
  page: number;
  view: DashboardViewMode;
  appointment: string | null;
}

export const DEFAULT_DASHBOARD_STATE: DashboardState = {
  tile: 'active',
  q: '',
  sortBy: 'updatedAt',
  sortOrder: 'desc',
  page: 1,
  view: 'flat',
  appointment: null,
};

const TILES = Object.keys(TILE_FILTERS) as Array<Exclude<DashboardTileFilter, null>>;
const SORTS: DashboardSortBy[] = ['createdAt', 'updatedAt', 'status', 'lastActivityAt'];

/** Read the dashboard's filters, search, sort, page, view and open drawer from the URL. */
export function parseDashboardParams(params: URLSearchParams): DashboardState {
  const tileParam = params.get('tile');
  const tile: DashboardTileFilter =
    tileParam === 'all' ? null : TILES.includes(tileParam as never) ? (tileParam as DashboardTileFilter) : DEFAULT_DASHBOARD_STATE.tile;
  const sortParam = params.get('sort');
  const page = parseInt(params.get('page') ?? '', 10);
  return {
    tile,
    q: params.get('q') ?? '',
    sortBy: SORTS.includes(sortParam as DashboardSortBy) ? (sortParam as DashboardSortBy) : DEFAULT_DASHBOARD_STATE.sortBy,
    sortOrder: params.get('order') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 0 ? page : 1,
    view: params.get('view') === 'grouped' ? 'grouped' : 'flat',
    appointment: params.get('appointment') || null,
  };
}

/** The URL for a dashboard state (defaults omitted, so the plain URL stays clean). */
export function dashboardParamsFromState(state: DashboardState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.tile !== DEFAULT_DASHBOARD_STATE.tile) params.set('tile', state.tile ?? 'all');
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.sortBy !== DEFAULT_DASHBOARD_STATE.sortBy) params.set('sort', state.sortBy);
  if (state.sortOrder !== DEFAULT_DASHBOARD_STATE.sortOrder) params.set('order', state.sortOrder);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.view !== DEFAULT_DASHBOARD_STATE.view) params.set('view', state.view);
  if (state.appointment) params.set('appointment', state.appointment);
  return params;
}

/** The list query for a dashboard state — every filter applied by the server. */
export function buildDashboardQuery(state: DashboardState): AppointmentFilters {
  return {
    ...(state.tile ? TILE_FILTERS[state.tile] : {}),
    ...(state.q.trim() ? { q: state.q.trim() } : {}),
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    page: state.page,
    limit: DASHBOARD_PAGE_SIZE,
  };
}

/**
 * Tile counts, all from /stats (i.e. over the whole table). Needs Attention
 * and Human Control used to be counted from the one 100-row page the
 * dashboard had loaded, so they undercounted exactly the stuck rows.
 */
export function tileCounts(stats: DashboardStats) {
  const by = (status: string) => stats.byStatus[status] || 0;
  return {
    active: by('pending') + by('contacted') + by('negotiating'),
    pending: by('pending'),
    contacted: by('contacted'),
    negotiating: by('negotiating'),
    confirmed: by('confirmed'),
    postSession: by('session_held') + by('feedback_requested') + by('completed'),
    attention: stats.needsAttention ?? 0,
    human: stats.humanControl ?? 0,
    awaitingVerification: stats.awaitingVerification ?? 0,
    cancelled: by('cancelled'),
    confirmedWeek: stats.confirmedLast7Days || 0,
  };
}
