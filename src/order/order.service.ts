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
import { OrderReqRo } from './orderreq.dto';
import { OrderReqEntity } from './orderreq.entity';
import { OrderSucEntity } from './ordersuc.entity';
import { TotalEntity } from './total.entity';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity)
    private orderRepository: Repository<OrderEntity>,
    @InjectRepository(UserEntity)
    private usersRepository: Repository<UserEntity>,
    @InjectRepository(OrderReqEntity)
    private orderReqRepository: Repository<OrderReqEntity>,
    @InjectRepository(OrderSucEntity)
    private orderSucRepository: Repository<OrderSucEntity>,
    @InjectRepository(TotalEntity)
    private totalRepository: Repository<TotalEntity>,
  ) {}
  private minioClient = new Minio.Client({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });

  async signUrl(order: OrderEntity): Promise<UserEntity | any> {
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
      owner: user,
    });
    order = await this.orderRepository.save(order);
    order = await this.orderRepository.findOne({
      where: { id: order.id },
      relations: ['reqs'],
    });
    order = await this.signUrl(order);
    return order.toResponseObject();
  }

  async update(orderId: string, data: Partial<OrderDTO>) {
    let order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['reqs'],
    });
    if (!order) {
      throw new HttpException('Order do not exist', HttpStatus.BAD_REQUEST);
    }
    if (order.reqs.length > 0) {
      throw new HttpException(
        'Order already has reqs!',
        HttpStatus.BAD_REQUEST,
      );
    }
    await this.orderRepository.update({ id: orderId }, data);
    order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['reqs'],
    });
    order = await this.signUrl(order);
    return order.toResponseObject();
  }

  async showAll(userId: string): Promise<OrderRO[]> {
    let orders: OrderEntity[];
    if (userId !== '') {
      const user = await this.usersRepository.findOne({ id: userId });
      orders = await this.orderRepository.find({
        where: { owner: user },
        relations: ['reqs'],
      });
    } else {
      // 接令者查看，只给看待接的
      orders = await this.orderRepository.find({
        where: { state: 0 },
        relations: ['reqs'],
      });
    }

    orders = await Promise.all(orders.map(order => this.signUrl(order)));
    return orders.map(order => order.toResponseObject());
  }

  async deleteOrder(orderId: string) {
    let order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['reqs'],
    });
    if (!order) {
      throw new HttpException('Order do not exist', HttpStatus.BAD_REQUEST);
    }
    if (order.reqs.length > 0) {
      throw new HttpException(
        'Order already has reqs!',
        HttpStatus.BAD_REQUEST,
      );
    }
    order = await this.orderRepository.findOne({ id: orderId });

    await this.orderRepository.delete({ id: orderId });
  }

  async fetchOrderReqs(orderId: string): Promise<OrderReqRo[]> {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['reqs'],
    });
    if (!order) {
      throw new HttpException('Order do not exist', HttpStatus.BAD_REQUEST);
    }
    let reqs = order.reqs;
    reqs = reqs.filter(x => x.state < 3);
    const reqsTmp = await Promise.all(
      reqs.map(
        async x =>
          await this.orderReqRepository.findOne({
            where: { id: x.id },
            relations: ['reqUser'],
          }),
      ),
    );
    return reqsTmp.map(x => x.toResponseObject());
  }

  async handleOrderReq(orderId: string, reqId: string, agree: boolean) {
    const order = await this.orderRepository.findOne({
      where: { id: orderId },
      relations: ['reqs', 'owner'],
    });
    if (!order) {
      throw new HttpException('Order do not exist', HttpStatus.BAD_REQUEST);
    }
    let req = order.reqs.filter(x => x.id == reqId)[0];
    if (agree === true) {
      if (req.state >= 1) {
        throw new HttpException('Req already handled!', HttpStatus.BAD_REQUEST);
      }
      req.state = 1;
      await this.orderReqRepository.save(req);

      order.commit += 1;
      if (order.commit > order.people) {
        throw new HttpException('Order already finsh!', HttpStatus.BAD_REQUEST);
      }
      req = await this.orderReqRepository.findOne({
        where: { id: req.id },
        relations: ['reqUser'],
      });
      const orderSuc = this.orderSucRepository.create({
        req: req,
        reqUser: req.reqUser,
        owner: order.owner,
        finishDate: new Date(),
        pay: 3,
        commission: 1,
      });
      let total = await this.totalRepository.findOne({
        where: { city: order.owner.city, type: order.type },
      });
      if (!total) {
        total = this.totalRepository.create({
          city: order.owner.city,
          type: order.type,
          count: 0,
          income: 0,
        });
      }
      total.count += 1;
      total.income += 1;
      await this.totalRepository.save(total);
      // 任务完成
      await this.orderSucRepository.save(orderSuc);
      if (order.commit == order.people) {
        // 召集令完成
        order.state = 1;
      }
      await this.orderRepository.save(order);

      return orderSuc;
    } else {
      req.state = 2;
      await this.orderReqRepository.save(req);
    }
  }
}
