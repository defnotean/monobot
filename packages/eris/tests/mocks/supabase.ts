// Mock Supabase client for testing
const tables = new Map<string, any[]>();

function createMockTable(name: string) {
  if (!tables.has(name)) tables.set(name, []);
  return {
    select: (cols = "*") => ({
      eq: (col: string, val: any) => ({
        single: async () => {
          const rows = tables.get(name) || [];
          const match = rows.find(r => r[col] === val);
          return { data: match || null, error: null };
        },
        order: (col2: string, opts?: any) => ({
          limit: (n: number) => ({
            single: async () => {
              const rows = (tables.get(name) || []).filter(r => r[col] === val);
              return { data: rows[0] || null, error: null };
            },
          }),
        }),
        limit: (n: number) => ({ data: (tables.get(name) || []).filter(r => r[col] === val).slice(0, n), error: null }),
      }),
      order: (col: string, opts?: any) => ({
        limit: (n: number) => ({ data: (tables.get(name) || []).slice(0, n), error: null }),
      }),
      gt: (col: string, val: any) => ({
        order: () => ({ limit: () => ({ single: async () => ({ data: null, error: null }) }) }),
      }),
      or: (filter: string) => ({
        single: async () => ({ data: null, error: null }),
        limit: (n: number) => ({ data: [], error: null }),
        order: (col: string) => ({ data: [], error: null }),
      }),
    }),
    insert: async (row: any) => {
      const rows = tables.get(name) || [];
      const newRow = { id: `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`, ...row, created_at: new Date().toISOString() };
      rows.push(newRow);
      tables.set(name, rows);
      return { data: newRow, error: null, select: () => ({ single: async () => ({ data: newRow, error: null }) }) };
    },
    upsert: async (row: any) => {
      const rows = tables.get(name) || [];
      const key = Object.keys(row)[0];
      const idx = rows.findIndex(r => r[key] === row[key]);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...row };
      else rows.push(row);
      tables.set(name, rows);
      return { error: null };
    },
    update: (updates: any) => ({
      eq: (col: string, val: any) => ({
        eq: async () => {
          const rows = tables.get(name) || [];
          const row = rows.find(r => r[col] === val);
          if (row) Object.assign(row, updates);
          return { error: null };
        },
      }),
    }),
    delete: () => ({
      eq: (col: string, val: any) => ({
        eq: async (col2: string, val2: any) => {
          const rows = tables.get(name) || [];
          tables.set(name, rows.filter(r => !(r[col] === val && r[col2] === val2)));
          return { error: null };
        },
      }),
      lt: (col: string, val: any) => ({ then: () => {}, catch: () => {} }),
    }),
    rpc: async () => ({ error: null }),
  };
}

export function createMockSupabase() {
  return {
    from: (table: string) => createMockTable(table),
    _tables: tables,
    _reset: () => tables.clear(),
  };
}

export function resetMockData() {
  tables.clear();
}
