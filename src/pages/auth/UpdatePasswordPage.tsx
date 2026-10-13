import {useEffect, useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {supabase} from '@/lib/supabase';

/**
 * Public page: set a new password after following a Supabase recovery link.
 * Supabase exchanges the link token into a session automatically
 * (detectSessionInUrl); this page waits for the session, then calls updateUser.
 */
export function UpdatePasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const sessionQuery = useQuery({
    queryKey: ['recovery-session'],
    queryFn: async () => {
      if (!supabase) throw new Error('Для смены пароля нужен Supabase.');
      // Give detectSessionInUrl a moment to process ?code / #access_token.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const {data} = await supabase.auth.getSession();
        if (data.session?.user) return data.session.user;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error('NO_SESSION');
    },
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (!supabase) return;
    const {data: listener} = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') void sessionQuery.refetch();
    });
    return () => listener.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error('Для смены пароля нужен Supabase.');
      if (password.length < 6) throw new Error('Пароль должен быть не короче 6 символов.');
      if (password !== confirm) throw new Error('Пароли не совпадают.');
      const {error} = await supabase.auth.updateUser({password});
      if (error) throw new Error(error.message);
      await supabase.auth.signOut();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <section className="admin-login-wrap">
      <Card className="admin-login-card">
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={1}>Новый пароль</Heading>
            <Text color="secondary">Придумайте новый пароль для входа.</Text>
          </VStack>
          {sessionQuery.isLoading ? (
            <Text color="secondary" role="status">Проверяем ссылку восстановления…</Text>
          ) : sessionQuery.isError ? (
            <VStack gap={2}>
              <Banner
                status="error"
                title="Ссылка недействительна"
                description="Ссылка устарела или уже использована. Запросите новую."
              />
              <Link className="admin-link" to="/reset-password">Запросить новую ссылку</Link>
            </VStack>
          ) : mutation.isSuccess ? (
            <VStack gap={2}>
              <Banner status="success" title="Пароль обновлён" description="Теперь войдите с новым паролем." />
              <Link className="admin-link" to="/reset-password">Готово</Link>
            </VStack>
          ) : (
            <form className="admin-login-form" onSubmit={submit}>
              <label className="admin-field">
                <small>Новый пароль</small>
                <input autoComplete="new-password" type="password" minLength={6} onChange={(event) => setPassword(event.currentTarget.value)} required value={password} />
              </label>
              <label className="admin-field">
                <small>Повторите пароль</small>
                <input autoComplete="new-password" type="password" minLength={6} onChange={(event) => setConfirm(event.currentTarget.value)} required value={confirm} />
              </label>
              {mutation.isError ? (
                <Banner
                  status="error"
                  title="Не удалось сохранить"
                  description={mutation.error instanceof Error ? mutation.error.message : 'Попробуйте ещё раз.'}
                />
              ) : null}
              <Button label="Сохранить пароль" type="submit" variant="primary" isLoading={mutation.isPending} isDisabled={!password || !confirm} />
            </form>
          )}
        </VStack>
      </Card>
    </section>
  );
}
