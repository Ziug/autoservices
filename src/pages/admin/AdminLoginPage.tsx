import {useState, type FormEvent} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {useMutation} from '@tanstack/react-query';
import {ShieldCheck} from '@phosphor-icons/react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {adminUrl, getAdminBasePath} from '@/lib/admin-config';
import {signInAdmin} from '@/lib/admin-api';

/** Only allow relative admin- scoped redirects after login (no open redirect). */
function safeNextPath(raw: string): string {
  const base = getAdminBasePath();
  if (typeof raw !== 'string' || !raw.startsWith(base + '/') && raw !== base) return adminUrl('dashboard');
  if (raw.startsWith('//') || raw.includes('://')) return adminUrl('dashboard');
  return raw;
}

/** Hidden Super Admin login. Server verifies platform-admin membership; the UI only navigates. */
export function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const next = safeNextPath((location.state as {next?: string} | null)?.next ?? adminUrl('dashboard'));

  const mutation = useMutation({
    mutationFn: () => signInAdmin(email.trim(), password),
    onSuccess: () => navigate(next, {replace: true}),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email || !password || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <section className="admin-login-wrap">
      <Card className="admin-login-card">
        <VStack gap={3}>
          <ShieldCheck size={28} aria-hidden="true" />
          <VStack gap={1}>
            <Heading level={1}>Панель управления</Heading>
            <Text color="secondary">Войдите по учётным данным администратора платформы.</Text>
          </VStack>
          <form className="admin-login-form" onSubmit={submit}>
            <label className="admin-field">
              <small>Почта</small>
              <input autoComplete="username" type="email" onChange={(event) => setEmail(event.currentTarget.value)} required value={email} />
            </label>
            <label className="admin-field">
              <small>Пароль</small>
              <input autoComplete="current-password" type="password" onChange={(event) => setPassword(event.currentTarget.value)} required value={password} />
            </label>
            {mutation.isError ? (
              <Banner
                status="error"
                title="Не удалось войти"
                description={mutation.error instanceof Error ? mutation.error.message : 'Проверьте данные и попробуйте ещё раз.'}
              />
            ) : null}
            <Button label="Войти" type="submit" variant="primary" isLoading={mutation.isPending} isDisabled={!email || !password} />
          </form>
        </VStack>
      </Card>
    </section>
  );
}
