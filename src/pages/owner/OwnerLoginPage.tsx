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
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => signInOwner(identifier.trim(), password),
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
        <Text color="secondary">Войдите под именем пользователя и паролем, созданным в Supabase Auth.</Text>
        <form className="field-grid" onSubmit={submit}>
          <label className="field"><small>Имя пользователя</small><input autoComplete="username" type="text" value={identifier} onChange={(event) => setIdentifier(event.currentTarget.value)} required /></label>
          <label className="field"><small>Пароль</small><input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} required /></label>
          {mutation.isError ? <p className="form-error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Не удалось войти.'}</p> : null}
          <Button label="Войти" type="submit" variant="primary" isLoading={mutation.isPending} isDisabled={!identifier || !password} />
        </form>
        <Link to="/reset-password">Забыли пароль?</Link>
        <Link to={`/s/${business.slug}/`}>Вернуться на страницу студии</Link>
      </section>
    </section>
  );
}
