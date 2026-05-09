import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchEmployees, createEmployee, updateEmployee, deleteEmployee,
  syncEmployeesFromTeams, fetchUnrecognized, fetchEmployeeDetail,
  fetchTeams, getEmployeeCsvUrl
} from '../utils/zoomApi';

function istDate() {
  const now = new Date();
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

function fmtMins(m) {
  if (!m) return '-';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h > 0 && min > 0) return `${h}hr ${min}min`;
  if (h > 0) return `${h}hr`;
  return `${min}min`;
}

const CATEGORIES = ['employee', 'visitor', 'interview', 'contractor', 'other'];

export default function EmployeeManager({ user }) {
  const [employees, setEmployees] = useState([]);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterStatus, setFilterStatus] = useState('active');
  const [filterTeam, setFilterTeam] = useState('');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [unrecognized, setUnrecognized] = useState([]);
  const [showUnrecognized, setShowUnrecognized] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [empDetail, setEmpDetail] = useState(null);
  const [detailMonth, setDetailMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // Form
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formCategory, setFormCategory] = useState('employee');
  const [formStatus, setFormStatus] = useState('active');
  const [formNotes, setFormNotes] = useState('');

  const loadEmployees = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search) params.search = search;
      if (filterCat) params.category = filterCat;
      if (filterStatus) params.status = filterStatus;
      if (filterTeam) params.team_id = filterTeam;
      const data = await fetchEmployees(params);
      setEmployees(data.employees || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [search, filterCat, filterStatus, filterTeam]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);
  useEffect(() => {
    fetchTeams().then(d => setTeams(d.teams || [])).catch(() => {});
  }, []);

  const handleSync = async () => {
    try {
      const r = await syncEmployeesFromTeams();
      alert(`Synced: ${r.added} employees added from teams`);
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const handleCreate = async () => {
    if (!formName.trim()) return;
    try {
      await createEmployee({
        participant_name: formName, email: formEmail,
        category: formCategory, status: formStatus, notes: formNotes
      });
      setShowAdd(false);
      resetForm();
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const handleUpdate = async () => {
    if (!editing) return;
    try {
      await updateEmployee(editing.employee_id, {
        display_name: formName, participant_email: formEmail,
        category: formCategory, status: formStatus, notes: formNotes
      });
      setEditing(null);
      resetForm();
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete ${name} from registry?`)) return;
    try {
      await deleteEmployee(id);
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const handleDisable = async (emp) => {
    try {
      await updateEmployee(emp.employee_id, { status: emp.status === 'active' ? 'disabled' : 'active' });
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const openEdit = (emp) => {
    setEditing(emp);
    setFormName(emp.display_name || emp.participant_name);
    setFormEmail(emp.participant_email || '');
    setFormCategory(emp.category || 'employee');
    setFormStatus(emp.status || 'active');
    setFormNotes(emp.notes || '');
    setShowAdd(false);
  };

  const resetForm = () => {
    setFormName(''); setFormEmail(''); setFormCategory('employee');
    setFormStatus('active'); setFormNotes('');
  };

  const loadUnrecognized = async () => {
    try {
      const d = await fetchUnrecognized(istDate());
      setUnrecognized(d.unrecognized || []);
      setShowUnrecognized(true);
    } catch (e) { setError(e.message); }
  };

  const addFromUnrecognized = async (p, category) => {
    try {
      await createEmployee({
        participant_name: p.normalized_name || p.participant_name,
        email: p.participant_email, category
      });
      setUnrecognized(prev => prev.filter(x => x.participant_name !== p.participant_name));
      loadEmployees();
    } catch (e) { setError(e.message); }
  };

  const loadDetail = async (emp) => {
    setSelectedEmp(emp);
    try {
      const d = await fetchEmployeeDetail(emp.employee_id, detailMonth);
      setEmpDetail(d);
    } catch (e) { setError(e.message); }
  };

  const catColor = (c) => {
    switch (c) {
      case 'employee': return { bg: '#dcfce7', color: '#15803d' };
      case 'visitor': return { bg: '#dbeafe', color: '#1d4ed8' };
      case 'interview': return { bg: '#fef3c7', color: '#92400e' };
      case 'contractor': return { bg: '#f3e8ff', color: '#7c3aed' };
      default: return { bg: '#f1f5f9', color: '#475569' };
    }
  };

  return (
    <div>
      <div style={s.header}>
        <h2 style={s.title}>Employee Registry</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSync} style={s.syncBtn}>Sync from Teams</button>
          <button onClick={loadUnrecognized} style={s.unrecBtn}>Unrecognized Today</button>
          <button onClick={() => { setShowAdd(true); setEditing(null); resetForm(); }} style={s.addBtn}>+ Add</button>
        </div>
      </div>

      {error && <div style={s.error}>{error} <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>x</button></div>}

      {/* Filters */}
      <div style={s.filters}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name/email..." style={s.searchInput} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={s.select}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.select}>
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </select>
        <select value={filterTeam} onChange={e => setFilterTeam(e.target.value)} style={s.select}>
          <option value="">All Teams</option>
          {teams.map(t => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{employees.length} results</span>
      </div>

      {/* Add/Edit Form */}
      {(showAdd || editing) && (
        <div style={s.formCard}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '0 0 12px' }}>{editing ? 'Edit Employee' : 'Add Employee'}</h3>
          <div style={s.formRow}>
            <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Name *" style={s.input} />
            <input value={formEmail} onChange={e => setFormEmail(e.target.value)} placeholder="Email" style={s.input} />
          </div>
          <div style={s.formRow}>
            <select value={formCategory} onChange={e => setFormCategory(e.target.value)} style={s.select}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={formStatus} onChange={e => setFormStatus(e.target.value)} style={s.select}>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
            <input value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Notes" style={s.input} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <button onClick={() => { setShowAdd(false); setEditing(null); }} style={s.cancelBtn}>Cancel</button>
            <button onClick={editing ? handleUpdate : handleCreate} style={s.saveBtn}>{editing ? 'Update' : 'Add'}</button>
          </div>
        </div>
      )}

      {/* Unrecognized panel */}
      {showUnrecognized && (
        <div style={s.unrecPanel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Unrecognized Participants Today ({unrecognized.length})</span>
            <button onClick={() => setShowUnrecognized(false)} style={s.cancelBtn}>Close</button>
          </div>
          {unrecognized.length === 0 ? (
            <div style={{ color: '#94a3b8', fontSize: 13 }}>All participants are registered!</div>
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {unrecognized.map((p, i) => (
                <div key={i} style={s.unrecRow}>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{p.participant_name}</div>
                    {p.participant_email && <div style={{ fontSize: 11, color: '#64748b' }}>{p.participant_email}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => addFromUnrecognized(p, 'employee')} style={s.tagBtn}>Employee</button>
                    <button onClick={() => addFromUnrecognized(p, 'visitor')} style={{ ...s.tagBtn, background: '#dbeafe', color: '#1d4ed8' }}>Visitor</button>
                    <button onClick={() => addFromUnrecognized(p, 'interview')} style={{ ...s.tagBtn, background: '#fef3c7', color: '#92400e' }}>Interview</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Employee list */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Name</th>
              <th style={s.th}>Email</th>
              <th style={s.th}>Category</th>
              <th style={s.th}>Status</th>
              <th style={s.th}>Notes</th>
              <th style={s.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp, i) => {
              const cc = catColor(emp.category);
              return (
                <tr key={emp.employee_id} style={{ ...(i % 2 === 0 ? s.trEven : {}), opacity: emp.status === 'disabled' ? 0.5 : 1 }}>
                  <td style={{ ...s.td, fontWeight: 600 }}>
                    <span style={{ cursor: 'pointer', color: '#3b82f6' }} onClick={() => loadDetail(emp)}>
                      {emp.display_name || emp.participant_name}
                    </span>
                  </td>
                  <td style={{ ...s.td, color: '#64748b' }}>{emp.participant_email || '-'}</td>
                  <td style={s.td}>
                    <span style={{ ...s.badge, background: cc.bg, color: cc.color }}>{emp.category}</span>
                  </td>
                  <td style={s.td}>
                    <span style={{ ...s.badge, background: emp.status === 'active' ? '#dcfce7' : '#fef2f2', color: emp.status === 'active' ? '#15803d' : '#dc2626' }}>
                      {emp.status}
                    </span>
                  </td>
                  <td style={{ ...s.td, color: '#94a3b8', fontSize: 12 }}>{emp.notes || '-'}</td>
                  <td style={s.td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => openEdit(emp)} style={s.actionBtn}>Edit</button>
                      <button onClick={() => handleDisable(emp)} style={s.actionBtn}>
                        {emp.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => handleDelete(emp.employee_id, emp.participant_name)} style={{ ...s.actionBtn, color: '#dc2626' }}>Delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {employees.length === 0 && !loading && (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
            No employees found. Click "Sync from Teams" to populate.
          </div>
        )}
      </div>

      {/* Employee detail modal */}
      {selectedEmp && (
        <div style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) { setSelectedEmp(null); setEmpDetail(null); } }}>
          <div style={s.modal}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>{selectedEmp.display_name || selectedEmp.participant_name}</h3>
              <button onClick={() => { setSelectedEmp(null); setEmpDetail(null); }} style={s.cancelBtn}>Close</button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
              <input type="month" value={detailMonth} onChange={e => setDetailMonth(e.target.value)} style={s.input} />
              <button onClick={() => loadDetail(selectedEmp)} style={s.saveBtn}>Load</button>
              <a href={getEmployeeCsvUrl(selectedEmp.employee_id, detailMonth)} target="_blank" rel="noreferrer" style={s.csvLink}>CSV</a>
            </div>

            {empDetail && (
              <div>
                <div style={s.detailStats}>
                  <div><strong>Days Present:</strong> {empDetail.days_present}</div>
                  <div><strong>Total Active:</strong> {fmtMins(empDetail.total_active_mins)}</div>
                  <div><strong>Total Break:</strong> {fmtMins(empDetail.total_break_mins)}</div>
                  <div><strong>Total Isolation:</strong> {fmtMins(empDetail.total_isolation_mins)}</div>
                </div>
                <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>Date</th>
                        <th style={s.th}>Status</th>
                        <th style={s.th}>In</th>
                        <th style={s.th}>Out</th>
                        <th style={s.th}>Active</th>
                        <th style={s.th}>Break</th>
                        <th style={s.th}>Isolation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(empDetail.daily || []).map((d, i) => (
                        <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                          <td style={s.td}>{d.date}</td>
                          <td style={s.td}>
                            {(() => {
                              const st = (d.status || '').toLowerCase();
                              const bg = st === 'present' ? '#dcfce7' : st === 'half_day' ? '#fef3c7' : '#fef2f2';
                              const fg = st === 'present' ? '#15803d' : st === 'half_day' ? '#92400e' : '#dc2626';
                              return <span style={{ ...s.badge, background: bg, color: fg }}>{d.status}</span>;
                            })()}
                          </td>
                          <td style={s.td}>{d.first_seen_ist || '-'}</td>
                          <td style={s.td}>{d.last_seen_ist || '-'}</td>
                          <td style={{ ...s.td, fontWeight: 600, color: '#10b981' }}>{fmtMins(d.active_minutes)}</td>
                          <td style={{ ...s.td, color: '#f97316' }}>{fmtMins(d.break_minutes)}</td>
                          <td style={s.td}>{fmtMins(d.isolation_minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 },
  title: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },
  addBtn: { padding: '8px 16px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  syncBtn: { padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  unrecBtn: { padding: '8px 16px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  error: { padding: '10px 14px', background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  filters: { display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' },
  searchInput: { padding: '8px 14px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: 220, outline: 'none' },
  select: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer' },
  input: { flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, outline: 'none' },

  formCard: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 },
  formRow: { display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
  cancelBtn: { padding: '6px 14px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  saveBtn: { padding: '6px 14px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  unrecPanel: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: 16, marginBottom: 16 },
  unrecRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #fde68a' },
  tagBtn: { padding: '4px 10px', background: '#dcfce7', color: '#15803d', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' },

  tableWrap: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: 700 },
  th: { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', fontSize: 13, color: '#1e293b', borderBottom: '1px solid #f1f5f9' },
  trEven: { background: '#fafbfc' },
  badge: { padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, display: 'inline-block', textTransform: 'capitalize' },
  actionBtn: { padding: '4px 10px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 4, fontSize: 11, cursor: 'pointer', color: '#475569' },

  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: 16, padding: 24, width: 700, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' },
  detailStats: { display: 'flex', gap: 20, marginBottom: 16, fontSize: 13, color: '#475569', flexWrap: 'wrap' },
  csvLink: { padding: '6px 14px', background: '#10b981', color: '#fff', borderRadius: 6, fontSize: 12, fontWeight: 600, textDecoration: 'none', display: 'inline-block' },
};
