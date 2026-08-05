import { useEffect } from 'react';
import { useAuthStore } from './stores/auth';
import { LoginPage } from './pages/LoginPage';
import { AppShell } from './components/AppShell';

function App() {
  const ready = useAuthStore((s) => s.ready);
  const user = useAuthStore((s) => s.user);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!ready) {
    return <div className="splash">Loading…</div>;
  }
  return user ? <AppShell /> : <LoginPage />;
}

export default App;
