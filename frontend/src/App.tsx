import { Routes, Route } from 'react-router-dom';
import TherapistsPage from './pages/TherapistsPage';
import TherapistDetailPage from './pages/TherapistDetailPage';
import AdminIngestionPage from './pages/AdminIngestionPage';
import AdminDashboardPage from './pages/AdminDashboardPage';
import AdminKnowledgePage from './pages/AdminKnowledgePage';
import AdminSettingsPage from './pages/AdminSettingsPage';
import FeedbackFormPage from './pages/FeedbackFormPage';
import AdminFormsPage from './pages/AdminFormsPage';
import Layout from './components/Layout';
import AdminLayout from './components/AdminLayout';
import ErrorBoundary from './components/ErrorBoundary';

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

        {/* Admin routes with sidebar layout */}
        <Route
          path="/admin/dashboard"
          element={
            <AdminLayout>
              <AdminDashboardPage />
            </AdminLayout>
          }
        />
        <Route
          path="/admin/ingestion"
          element={
            <AdminLayout>
              <AdminIngestionPage />
            </AdminLayout>
          }
        />
        <Route
          path="/admin/knowledge"
          element={
            <AdminLayout>
              <AdminKnowledgePage />
            </AdminLayout>
          }
        />
        <Route
          path="/admin/forms"
          element={
            <AdminLayout>
              <AdminFormsPage />
            </AdminLayout>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <AdminLayout>
              <AdminSettingsPage />
            </AdminLayout>
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
