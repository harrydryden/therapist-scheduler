import { lazy, Suspense } from 'react';
import { Routes, Route, Link, Outlet } from 'react-router-dom';
import TherapistsPage from './pages/TherapistsPage';
import TherapistDetailPage from './pages/TherapistDetailPage';
import FeedbackFormPage from './pages/FeedbackFormPage';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './context/AuthContext';

// Lazy-load admin pages to reduce initial bundle size for public users
const AdminHomePage = lazy(() => import('./pages/AdminHomePage'));
const AdminIngestionPage = lazy(() => import('./pages/AdminIngestionPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const AdminKnowledgePage = lazy(() => import('./pages/AdminKnowledgePage'));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage'));
const AdminFormsPage = lazy(() => import('./pages/AdminFormsPage'));
const AdminAppointmentsPage = lazy(() => import('./pages/AdminAppointmentsPage'));
const AdminWorkReportsPage = lazy(() => import('./pages/AdminWorkReportsPage'));
const AdminVouchersPage = lazy(() => import('./pages/AdminVouchersPage'));

function AdminLoadingFallback() {
  return (
    <div className="flex items-center justify-center p-12">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800"></div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <Routes>
        {/* Public routes with standard layout */}
        <Route
          path="/"
          element={
            <Layout>
              <TherapistsPage />
            </Layout>
          }
        />
        <Route
          path="/therapist/:id"
          element={
            <Layout>
              <TherapistDetailPage />
            </Layout>
          }
        />
        {/* Feedback form has its own full-page layout */}
        <Route path="/feedback" element={<FeedbackFormPage />} />
        <Route path="/feedback/:splCode" element={<FeedbackFormPage />} />

        {/* Admin routes with sidebar layout - lazy loaded.
            A single Suspense boundary wraps all admin children so we
            don't repeat the fallback wiring for every route. */}
        <Route
          path="/admin"
          element={
            <AuthProvider>
              <ToastProvider>
                <AdminLayout />
              </ToastProvider>
            </AuthProvider>
          }
        >
          <Route
            element={
              <Suspense fallback={<AdminLoadingFallback />}>
                <Outlet />
              </Suspense>
            }
          >
            <Route index element={<AdminHomePage />} />
            <Route path="dashboard" element={<AdminDashboardPage />} />
            <Route path="appointments" element={<AdminAppointmentsPage />} />
            <Route path="vouchers" element={<AdminVouchersPage />} />
            <Route path="ingestion" element={<AdminIngestionPage />} />
            <Route path="knowledge" element={<AdminKnowledgePage />} />
            <Route path="forms" element={<AdminFormsPage />} />
            <Route path="settings" element={<AdminSettingsPage />} />
            <Route path="work-reports" element={<AdminWorkReportsPage />} />
          </Route>
        </Route>

        {/* 404 catch-all route */}
        <Route
          path="*"
          element={
            <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
                <h1 className="text-4xl font-bold text-gray-900 mb-2">404</h1>
                <p className="text-gray-600 mb-6">Page not found</p>
                <Link
                  to="/"
                  className="inline-block px-6 py-3 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
                >
                  Go back home
                </Link>
              </div>
            </div>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
