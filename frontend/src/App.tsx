import { Routes, Route } from 'react-router-dom';
import TherapistsPage from './pages/TherapistsPage';
import TherapistDetailPage from './pages/TherapistDetailPage';
import AdminIngestionPage from './pages/AdminIngestionPage';
import AdminDashboardPage from './pages/AdminDashboardPage';
import AdminKnowledgePage from './pages/AdminKnowledgePage';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary>
      <Layout>
        <Routes>
          <Route path="/" element={<TherapistsPage />} />
          <Route path="/therapist/:id" element={<TherapistDetailPage />} />
          <Route path="/admin/ingestion" element={<AdminIngestionPage />} />
          <Route path="/admin/dashboard" element={<AdminDashboardPage />} />
          <Route path="/admin/knowledge" element={<AdminKnowledgePage />} />
        </Routes>
      </Layout>
    </ErrorBoundary>
  );
}

export default App;
