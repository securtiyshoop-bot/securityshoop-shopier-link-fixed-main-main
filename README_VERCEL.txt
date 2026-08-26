SecurityShoop - Vercel Kurulum

1) ZIP'i aç.
2) İçindeki securityshoop_yeni klasörünü GitHub reposuna yükle.
3) Vercel > New Project > GitHub reposunu seç > Deploy.
4) Vercel > Project Settings > Environment Variables bölümüne ekle:
   SESSION_SECRET=uzun-rastgele-bir-sifre
   ADMIN_USERNAME=SecurityShoop
   ADMIN_EMAIL=sakatat7571@gmail.com
   ADMIN_PASSWORD=Anadolu2654.

Önemli:
- Vercel'de localhost MySQL çalışmaz.
- Plugin hesaplarının admin panelde görünmesi için dış MySQL zorunludur. Örn: Railway MySQL, PlanetScale vb.
- Dış veritabanı kullanırsan şu env değerlerini Vercel'e gir:
  DB_HOST
  DB_PORT
  DB_USER
  DB_PASSWORD
  DB_NAME
- DB girilmezse site açılır ama plugin hesap kaydı kabul edilmez. Bu özellikle hesap oluşturulmuş gibi görünüp admin panelde görünmeme sorununu engeller.
- Kontrol için şu adresi aç:
  /api/storage-status
  "persistent": true görmelisin.
