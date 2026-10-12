import {describe, expect, it} from 'vitest';
import {mergeOwnerGallery} from '../scripts/tenant-publishing.mjs';

describe('republishing a tenant gallery', () => {
  it('keeps owner-replaced images and appends photos uploaded in the cabinet', () => {
    const configured = [
      {id: 'paint', image: '/tenants/north-studio/images/paint.jpg', caption: 'Полировка', position: 0},
    ];
    const stored = [
      {id: 'paint', image: 'https://project.supabase.co/storage/v1/object/public/tenant-media/north-studio/gallery/new.webp', caption: 'Old caption', position: 0},
      {id: 'owner-added', image: 'https://project.supabase.co/storage/v1/object/public/tenant-media/north-studio/gallery/detail.webp', caption: 'Новая работа', position: 1},
    ];

    expect(mergeOwnerGallery(configured, stored)).toEqual([
      {id: 'paint', image: stored[0].image, caption: 'Полировка', position: 0},
      {id: 'owner-added', image: stored[1].image, caption: 'Новая работа', position: 1},
    ]);
  });

  it('uses an updated config image when the stored image is not an owner upload', () => {
    const configured = [{id: 'paint', image: '/tenants/north-studio/images/updated.jpg', caption: 'Полировка', position: 0}];
    const stored = [{id: 'paint', image: 'https://images.example.test/old.jpg', caption: 'Старое фото', position: 0}];

    expect(mergeOwnerGallery(configured, stored)).toEqual(configured);
  });
});
