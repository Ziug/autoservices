import {z} from 'zod';

export const bookingContactSchema = z.object({
  customerName: z.string().trim().min(2, 'Введите имя полностью.').max(100),
  customerPhone: z.string().trim().min(5, 'Укажите телефон для связи.').max(40).regex(/^[+\d() .-]+$/, 'Проверьте номер телефона.'),
  vehicle: z.string().trim().min(2, 'Укажите марку и модель автомобиля.').max(120),
});

export type BookingContact = z.infer<typeof bookingContactSchema>;
