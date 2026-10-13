import {useState, type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {useMutation} from '@tanstack/react-query';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {supabase} from '@/lib/supabase';

/** Public page: request a Supabase Auth password-recovery email. */
export function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error('Для восстановления нужен Supabase.');
      const {error} = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/update-password`,
      });
      if (error) throw new Error(error.message);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <section className="admin-login-wrap">
      <Card className="admin-login-card">
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={1}>Восстановление пароля</Heading>
            <Text color="secondary">Отправим письмо со ссылкой для установки нового пароля.</Text>
          </VStack>
          {mutation.isSuccess ? (
            <Banner
              status="success"
              title="Письмо отправлено"
              description="Проверьте почту и перейдите по ссылке — она откроет страницу установки нового пароля."
            />
          ) : (
            <form className="admin-login-form" onSubmit={submit}>
              <label className="admin-field">
                <small>Почта</small>
                <input autoComplete="username" type="email" onChange={(event) => setEmail(event.currentTarget.value)} required value={email} />
              </label>
              {mutation.isError ? (
                <Banner
                  status="error"
                  title="Не удалось отправить"
                  description={mutation.error instanceof Error ? mutation.error.message : 'Попробуйте ещё раз.'}
                />
              ) : null}
              <Button label="Отправить ссылку" type="submit" variant="primary" isLoading={mutation.isPending} isDisabled={!email} />
            </form>
          )}
          <Link className="admin-link" to="/">На главную</Link>
        </VStack>
      </Card>
    </section>
  );
}
