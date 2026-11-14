FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /source
COPY aspnet/SakanGo.Api.csproj aspnet/
RUN dotnet restore aspnet/SakanGo.Api.csproj
COPY aspnet/ aspnet/
RUN dotnet publish aspnet/SakanGo.Api.csproj -c Release -o /out --no-restore
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out/ ./
COPY web/ ./wwwroot/
ENV ASPNETCORE_URLS=http://0.0.0.0:10000
EXPOSE 10000
ENTRYPOINT ["dotnet","SakanGo.Api.dll"]