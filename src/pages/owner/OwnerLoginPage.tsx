import {useState, type FormEvent} from 'react';
import {Link, useNavigate} from 'react-router-dom';
import {useMutation} from '@tanstack/react-query';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import {useTenant} from '@/App';
import {signInOwner} from '@/lib/tenant-api';

export function OwnerLoginPage() {
  const business = useTenant();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => signInOwner(email.trim(), password),
    onSuccess: () => navigate(`/s/${business.slug}/owner/`, {replace: true}),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <section className="page-content">
      <section className="booking-panel owner-login">
        <p className="eyebrow">Кабинет владельца</p>
        <Heading level={1}>Войти в студию</Heading>
        <Text color="secondary">Войдите по рабочей почте и паролю, которые созданы в Supabase Auth.</Text>
        <form className="field-grid" onSubmit={submit}>
          <label className="field"><small>Почта</small><input autoComplete="username" type="email" onChange={(event) => setEmail(event.currentTarget.value)} required value={email} /></label>
          <label className="field"><small>Пароль</small><input autoComplete="current-password" type="password" onChange={(event) => setPassword(event.currentTarget.value)} required value={password} /></label>
          {mutation.isError ? <p className="form-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось войти.'}</p> : null}
          <Button label="Войти" type="submit" variant="primary" isLoading={mutation.isPending} isDisabled={!email || !password} />
        </form>
        <Link to="/reset-password">Забыли пароль?</Link>
        <Link to={`/s/${business.slug}/`}>Вернуться на страницу студии</Link>
      </section>
    </section>
  );
}
