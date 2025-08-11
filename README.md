Start PostgreSQL:

```
docker-compose up -d
```

Connect from another Mac on same LAN:

1. Find your Mac's IP: ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1

2. Update scraper/.env: DB_HOST=192.168.1.xxx (your IP)

Stop/cleanup:
docker-compose down
docker-compose down -v # Remove data too
