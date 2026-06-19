FROM nginx:alpine

# Copiamos todos los archivos del proyecto al directorio de Nginx
COPY . /usr/share/nginx/html

# Exponemos el puerto 80 dentro del contenedor
EXPOSE 80

# Mantenemos Nginx ejecutándose en primer plano
CMD ["nginx", "-g", "daemon off;"]
