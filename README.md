Start PostgreSQL:

```
docker-compose up -d
```

Connect from another Mac on same LAN:

1. Find your Mac's IP: ipconfig getifaddr en0

2. Update scraper/.env: DB_HOST=192.168.1.xxx (your IP)

Stop/cleanup:
docker-compose down
docker-compose down -v # Remove data too
