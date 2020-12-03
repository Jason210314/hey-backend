import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UserDTO, UserRO } from 'src/users/user.dto';
import { UserEntity } from 'src/users/user.entity';
import { Repository } from 'typeorm';
import { OrderDTO, OrderRO } from './order.dto';
import { OrderEntity } from './order.entity';
import * as nuid from 'nuid';
import Minio = require('minio');
import 'dotenv/config';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(UserEntity)
    private usersRepository: Repository<UserEntity>,
  ) {}
  private minioClient = new Minio.Client({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });

  async sigeUrl(order: OrderEntity) {
    order.picture = await this.minioClient.presignedUrl(
      'GET',
      process.env.BUCKET,
      order.picture,
    );
    return order;
  }

  async add(userId: string, file, data: Partial<OrderDTO>) {
    const user = await this.usersRepository.findOne({ id: userId });
    if (!this.minioClient.bucketExists(process.env.BUCKET)) {
      await this.minioClient.makeBucket(process.env.BUCKET, 'cn-north-1');
    }

    const filename = `${nuid.next()}.${file.mimetype.split('/')[1]}`;
    const metaData = { 'Content-Type': file.mimetype };
    await this.minioClient.putObject(
      process.env.BUCKET,
      filename,
      file.buffer,
      metaData,
    );

    let order = this.orderRepository.create({
      ...data,
      picture: filename,
      user: user,
    });
    order = await this.orderRepository.save(order);
    order = await this.sigeUrl(order);
    return order.toResponseObject();
  }

  async update(data: Partial<OrderDTO>) {
    const { id } = data;
    await this.orderRepository.update({ id }, data);
    let order = await this.orderRepository.findOne({ id });
    order = await this.sigeUrl(order);
    return order.toResponseObject();
  }

  async showAll(userId: string): Promise<OrderRO[]> {
    const user = await this.usersRepository.findOne({ id: userId });
    let orders = await this.orderRepository.find({ user: user });

    orders = await Promise.all(orders.map(order => this.sigeUrl(order)));
    return orders.map(order => order.toResponseObject());
  }
}
